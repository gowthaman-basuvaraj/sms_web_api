import "dotenv/config";
import Hapi from "@hapi/hapi";
import Database from "better-sqlite3";
import { format, subHours } from "date-fns";
import { Server } from "socket.io";
import cron from "node-cron";
import config from "./config.js";

const db = new Database(config.database.path);

db.prepare(
    `
      CREATE TABLE IF NOT EXISTS messages (
                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                            sender TEXT,
                                            text TEXT,
                                            sentStamp TEXT,
                                            sim TEXT,
                                            isRead BOOLEAN DEFAULT 0
      )
    `
).run();

db.prepare(
    `
      CREATE TABLE IF NOT EXISTS users (
                                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                                         username TEXT UNIQUE NOT NULL,
                                         role TEXT NOT NULL
      )
    `
).run();

db.prepare(
    `
      CREATE TABLE IF NOT EXISTS userPreferences (
                                                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                   user_id INTEGER,
                                                   sender_name TEXT,
                                                   mutePreferences BOOLEAN DEFAULT 1,
                                                   FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `
).run();

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

  io.on("connection", (socket) => {
    console.log("Client connected");
  });

  const broadcastMessage = (message) => {
    io.emit("newMessage", message);
  };

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
            message: "User to which messagae is sent does not exist",
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
            SELECT sender, MAX(sentStamp) AS LatestTime
            FROM messages
            GROUP BY sender
          )
          SELECT m.*,
                 (SELECT COUNT(*) FROM messages WHERE sender = m.sender AND isRead = 0) AS unreadCount
          FROM messages m
                 JOIN LatestMessages lm
                      ON m.sender = lm.sender AND m.sentStamp = lm.LatestTime
          ORDER BY m.sentStamp DESC;
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
      const { sender, sim } = request.query;

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

        query += " ORDER BY sentStamp DESC";

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
        return h.response({ status: "success", message: "Messages marked as read" }).code(200);
      } catch (error) {
        console.error(error);
        return h.response({ status: "error", message: "Failed to mark messages as read" }).code(500);
      }
    },
  });

  // Run every hour to delete messages older than 48 hours
  cron.schedule(config.cron.schedule, () => {
    const cutoffDate = format(
        subHours(new Date(), config.cron.retentionPeriodHours),
        "dd/MM/yyyy HH:mm:ss"
    );
    try {
      const deleteOldMessages = db.prepare(`
        DELETE FROM messages
        WHERE sentStamp < ?
      `);
      const result = deleteOldMessages.run(cutoffDate);
      console.log(`Deleted ${result.changes} old messages`);
    } catch (error) {
      console.error("Failed to delete old messages:", error);
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