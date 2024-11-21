import Hapi from "@hapi/hapi";
import Database from "better-sqlite3";
import {format} from "date-fns";

const db = new Database("./messages.db");

db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
                                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                                            sender TEXT,
                                            text TEXT,
                                            sentStamp TEXT,
                                            sim TEXT
    )
`).run();

const init = async () => {
    const server = Hapi.server({
        port: 3000,
        host: "localhost",
        routes: {
            cors: {
                origin: ["*"], // Allow all origins
                additionalHeaders: ["cache-control", "x-requested-with"],
            },
        },
    });

    // API 1: Send Message
    server.route({
        method: "POST",
        path: "/send-message",
        handler: (request, h) => {
            const { sender, text, sim } = request.payload;
            const sentStamp = format(new Date(), "dd/MM/yyyy hh:mm:ss a");

            try {
                const insert = db.prepare(`
                    INSERT INTO messages (sender, text, sentStamp, sim)
                    VALUES (?, ?, ?, ?)
                `);
                insert.run(sender, text, sentStamp, sim);
                return h.response({ status: "success", message: "Message sent" }).code(200);
            } catch (error) {
                console.error(error);
                return h.response({ status: "error", message: "Failed to send message" }).code(500);
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
                    SELECT m.*
                    FROM messages m
                             INNER JOIN (
                        SELECT sender, MAX(sentStamp) AS latest_received
                        FROM messages
                        GROUP BY sender
                    ) AS latest
                                        ON m.sender = latest.sender AND m.sentStamp = latest.latest_received
                    ORDER BY m.sentStamp DESC
                `);

                const messages = query.all();
                return h.response({ status: "success", messages }).code(200);
            } catch (error) {
                console.error(error);
                return h.response({ status: "error", message: "Failed to retrieve recent messages" }).code(500);
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
                return h.response({ status: "error", message: "Failed to retrieve messages" }).code(500);
            }
        },
    });


    await server.start();
    console.log("Server running on %s", server.info.uri);
};

process.on("unhandledRejection", (err) => {
    console.error(err);
    process.exit(1);
});

init();
