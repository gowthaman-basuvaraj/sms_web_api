import "dotenv/config";
import Hapi from "@hapi/hapi";
import Database from "better-sqlite3";
import { format } from "date-fns";
import { Server } from "socket.io";
import cron from "node-cron";
import config from "./config.js";
import authMiddleware, { authenticateToken } from "./authMiddleware.js";

const db = new Database(config.database.path);

// language=SQLite
db.prepare(
  `CREATE TABLE IF NOT EXISTS messages
   (
       id        INTEGER PRIMARY KEY AUTOINCREMENT,
       sender    TEXT,
       text      TEXT,
       sentStamp TEXT,
       sim       TEXT,
       isRead    BOOLEAN DEFAULT 0
   )`).run();

// language=SQLite
db.prepare(
  `CREATE TABLE IF NOT EXISTS users
   (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT UNIQUE NOT NULL,
     role     TEXT        NOT NULL
   )`).run();

// language=SQLite
db.prepare(
  `CREATE TABLE IF NOT EXISTS userPreferences
   (
       id              INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id         INTEGER,
       sender_name     TEXT,
       mutePreferences BOOLEAN DEFAULT 1,
       FOREIGN KEY (user_id) REFERENCES users (id)
   )`).run();

// Per-sender message retention, in days. A sender only appears here if it has a finite
// window; the default (no row) is "keep forever". This config is server-side only and is
// deliberately disjoint from the mobile app's retention settings.
// language=SQLite
db.prepare(
  `CREATE TABLE IF NOT EXISTS sender_retention
   (
       sender TEXT PRIMARY KEY,
       days   INTEGER NOT NULL
   )`).run();

// Parse a "dd/MM/yyyy HH:mm:ss" sentStamp (written in the server's UTC clock) to epoch ms,
// or null if it doesn't match. That format doesn't sort lexically by time, so retention
// compares parsed values rather than strings.
function parseStamp(stamp) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(stamp ?? "")
  );
  if (!m) return null;
  const [, dd, MM, yyyy, HH, mm, ss] = m;
  return Date.UTC(+yyyy, +MM - 1, +dd, +HH, +mm, +(ss || 0));
}

const init = async () => {
  const server = Hapi.server({
    port: config.server.port,
    host: config.server.host,
    routes: {
      cors: config.server.cors,
    },
  });

  const io = new Server(server.listener, {
    cors: config.socket.cors,
  });

  // Authenticate the realtime channel too — broadcasts carry SMS/OTP content, so an
  // unauthenticated socket would leak them to anyone who connects.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("No token provided"));
      await authenticateToken(token);
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", () => {
    console.log("Client connected");
  });

  const broadcastMessage = (message) => {
    io.emit("newMessage", message);
  };

  server.ext('onRequest', authMiddleware);

  // API 1: Send Message
  server.route({
    method: "POST",
    path: "/send-message",
    handler: (request, h) => {
      let { userName, sender, text, sim } = request.payload;
      const sentStamp = format(new Date(), "dd/MM/yyyy HH:mm:ss");

      if (sender.length > 3) {
        const remainingSender = sender.slice(3);
        const pattern = /^[a-zA-Z]{2}-/; // 2 alphabet followed by a hyphen
        if (pattern.test(sender) && remainingSender.length > 0) {
          sender = remainingSender;
        }
      }

      try {
        const userId = db
          .prepare(`SELECT id FROM users WHERE username =?`)
          .get(userName);

        if (!userId) {
          return h.response({
            status: "error",
            message: "User to which message is sent does not exist",
          });
        }

        const insert = db.prepare(`
          INSERT INTO messages (sender, text, sentStamp, sim, isRead)
          VALUES (?, ?, ?, ?, 0)
        `);
        insert.run(sender, text, sentStamp, sim);

        const senderPresent = db
          .prepare(
            `SELECT * FROM userPreferences WHERE user_id =? AND sender_name =?`
          )
          .get(userId.id, sender);

        if (!senderPresent) {
          const insertPreferenceQuery = `INSERT INTO userPreferences (user_id, sender_name, mutePreferences) VALUES (?, ?, ?)`;
          console.log("Insert Preference Query:", insertPreferenceQuery);
          db.prepare(insertPreferenceQuery).run(userId.id, sender, 1);
        }

        const newMessage = { sender, text, sentStamp, sim, isRead: 0 };
        broadcastMessage(newMessage);

        return h
          .response({ status: "success", message: "Message sent" })
          .code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({ status: "error", message: "Failed to send message" })
          .code(500);
      }
    },
  });

  // API 2: Get Recent Messages
  server.route({
    method: "GET",
    path: "/messages/recent",
    handler: (request, h) => {
      try {
        const query = db.prepare(`
          WITH LatestMessages AS (
            SELECT sender, MAX(id) AS LatestId
            FROM messages
            GROUP BY sender
          )
          SELECT m.*,
                 (SELECT COUNT(*) FROM messages WHERE sender = m.sender AND isRead = 0) AS unreadCount
          FROM messages m
                 JOIN LatestMessages lm
                      ON m.sender = lm.sender AND m.id = lm.LatestId
          ORDER BY m.id DESC;
        `);

        const messages = query.all();
        return h.response({ status: "success", messages }).code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({
            status: "error",
            message: "Failed to retrieve recent messages",
          })
          .code(500);
      }
    },
  });

  // API 3: Get Messages by Sender and SIM
  server.route({
    method: "GET",
    path: "/messages",
    handler: (request, h) => {
      // Cursor pagination: returns the newest `limit` messages (default 100). Pass
      // `before=<id>` to fetch the next older page. Ordered by id (autoincrement) so it's
      // chronologically correct and stable — the sentStamp string sort was neither.
      const { sender, sim, limit, before } = request.query;

      try {
        let query = `
          SELECT *
          FROM messages
          WHERE 1=1
        `;
        const params = [];

        if (sender) {
          query += " AND sender = ?";
          params.push(sender);
        }

        if (sim) {
          query += " AND sim = ?";
          params.push(sim);
        }

        if (before) {
          query += " AND id < ?";
          params.push(Number(before));
        }

        const pageSize = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
        query += " ORDER BY id DESC LIMIT ?";
        params.push(pageSize);

        const messages = db.prepare(query).all(params);

        return h.response({ status: "success", messages }).code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({ status: "error", message: "Failed to retrieve messages" })
          .code(500);
      }
    },
  });

  // API 4: Add User
  server.route({
    method: "POST",
    path: "/user",
    handler: (req, h) => {
      try {
        const { name, role } = req.payload;
        const checkUser = db.prepare(
          `SELECT COUNT(*) as count FROM users WHERE username = ?`
        );
        const existingUser = checkUser.get(name);

        if (existingUser.count === 0) {
          const insert = db.prepare(`
            INSERT INTO users (username, role) VALUES (?, ?)
          `);
          insert.run(name, role);
        }
        return h
          .response({ status: "success", message: "User added successfully" })
          .code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({ status: "error", message: "Failed to add user" })
          .code(500);
      }
    },
  });

  // API 5: Add User Preference
  server.route({
    method: "POST",
    path: "/user/preference",
    handler: (req, h) => {
      try {
        const { userName, senderName, mutePreferences } = req.payload;

        const userId = db
          .prepare(`SELECT id FROM users WHERE username =?`)
          .get(userName);

        const muteValue = mutePreferences ? 1 : 0;

        const senderPresent = db
          .prepare(
            `SELECT * FROM userPreferences WHERE user_id =? AND sender_name =?`
          )
          .get(userId.id, senderName);

        if (!senderPresent) {
          return h
            .response({
              status: "error",
              message: "sender to which preference is added does not exist",
            })
            .statusCode(404);
        }

        const insertPreferenceQuery = `UPDATE userPreferences SET mutePreferences =? WHERE user_id =? AND sender_name =?`;
        db.prepare(insertPreferenceQuery).run(muteValue, userId.id, senderName);

        console.log("Mute Value:", muteValue, insertPreferenceQuery);

        return h
          .response({
            status: "success",
            message: "User preference added successfully",
            mutePreferences: mutePreferences,
          })
          .code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({
            status: "error",
            message: "Failed to add user preference",
          })
          .code(500);
      }
    },
  });

  // API 6: Get User Preferences
  server.route({
    method: "GET",
    path: "/user/preferences",
    handler: (req, h) => {
      const { userName, sender } = req.query;
      try {
        const userId = db
          .prepare(`SELECT id FROM users WHERE username =?`)
          .get(userName);

        console.log("User ID:", userId);
        console.log("Sender:", sender);
        if (!userId) {
          return h
            .response({ status: "error", message: "User not found" })
            .code(404);
        }
        const query = db.prepare(`
          SELECT *
          FROM userPreferences
          WHERE user_id =? AND sender_name =?
        `);
        const preferences = query.all(userId.id, sender);
        console.log("Preferences:", preferences);
        return h.response({ status: "success", preferences }).code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({
            status: "error",
            message: "Failed to retrieve user preferences",
          })
          .code(500);
      }
    },
  });

  // API 7: Mark Messages as Read
  server.route({
    method: "POST",
    path: "/messages/mark-as-read",
    handler: (request, h) => {
      const { sender } = request.payload;
      try {
        const update = db.prepare(`
          UPDATE messages
          SET isRead = 1
          WHERE sender = ?
        `);
        update.run(sender);
        return h
          .response({ status: "success", message: "Messages marked as read" })
          .code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({
            status: "error",
            message: "Failed to mark messages as read",
          })
          .code(500);
      }
    },
  });

  // API 8: get all sender mute prefrence for specific user
  server.route({
    method: "GET",
    path: "/user/all/preferences",
    handler: (req, h) => {
      const { userName } = req.query;
      try {
        const userId = db
          .prepare(`SELECT id FROM users WHERE username =?`)
          .get(userName);

        console.log("User ID:", userId);
        if (!userId) {
          return h
            .response({ status: "error", message: "User not found" })
            .code(404);
        }
        const query = db.prepare(`
          SELECT *
          FROM userPreferences
          WHERE user_id =?
        `);
        const preferences = query.all(userId.id);
        console.log("Preferences:", preferences);
        return h.response({ status: "success", preferences }).code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({
            status: "error",
            message: "Failed to retrieve user preferences",
          })
          .code(500);
      }
    },
  });

  // API 8: List per-sender retention windows (only senders with a finite window).
  server.route({
    method: "GET",
    path: "/sender-retention",
    handler: (req, h) => {
      try {
        const rules = db
          .prepare(`SELECT sender, days FROM sender_retention ORDER BY sender`)
          .all();
        return h.response({ status: "success", rules }).code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({ status: "error", message: "Failed to read retention" })
          .code(500);
      }
    },
  });

  // API 9: Set a sender's retention window. days > 0 keeps that many days; days <= 0 (or
  // blank) removes the rule, reverting the sender to the default "keep forever".
  server.route({
    method: "POST",
    path: "/sender-retention",
    handler: (req, h) => {
      try {
        const { sender } = req.payload || {};
        const days = Number.parseInt(req.payload?.days, 10);
        if (!sender || typeof sender !== "string") {
          return h
            .response({ status: "error", message: "sender is required" })
            .code(400);
        }
        if (Number.isFinite(days) && days > 0) {
          db.prepare(
            `INSERT INTO sender_retention (sender, days) VALUES (?, ?)
             ON CONFLICT(sender) DO UPDATE SET days = excluded.days`
          ).run(sender, days);
          return h.response({ status: "success", sender, days }).code(200);
        }
        db.prepare(`DELETE FROM sender_retention WHERE sender = ?`).run(sender);
        return h.response({ status: "success", sender, days: 0 }).code(200);
      } catch (error) {
        console.error(error);
        return h
          .response({ status: "error", message: "Failed to set retention" })
          .code(500);
      }
    },
  });

  // Enforce per-sender retention. Only senders with a finite window are touched; everything
  // else is kept forever (the default). Runs on config.cron.schedule (hourly by default).
  cron.schedule(config.cron.schedule, () => {
    try {
      const rules = db
        .prepare(`SELECT sender, days FROM sender_retention WHERE days > 0`)
        .all();
      if (rules.length === 0) return;

      const now = Date.now();
      const selectBySender = db.prepare(
        `SELECT id, sentStamp FROM messages WHERE sender = ?`
      );
      let deleted = 0;
      const purge = db.transaction(() => {
        for (const { sender, days } of rules) {
          const cutoff = now - days * 86_400_000;
          const expired = selectBySender
            .all(sender)
            .filter((m) => {
              const t = parseStamp(m.sentStamp);
              return t !== null && t < cutoff;
            })
            .map((m) => m.id);
          for (let i = 0; i < expired.length; i += 400) {
            const chunk = expired.slice(i, i + 400);
            deleted += db
              .prepare(
                `DELETE FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`
              )
              .run(...chunk).changes;
          }
        }
      });
      purge();
      if (deleted > 0) console.log(`Retention: deleted ${deleted} message(s)`);
    } catch (error) {
      console.error("Failed to apply retention:", error);
    }
  });

  await server.start();
  console.log("Server running on %s", server.info.uri);
};

process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});

init();
