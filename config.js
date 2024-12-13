export default {
    jwt: {
        jwksUri: 'https://auth.readymixerp.com/realms/rmc-dev/protocol/openid-connect/certs',
    },
    server: {
        port: process.env.SERVER_PORT || 3000,
        host: process.env.SERVER_HOST || "localhost",
        cors: {
            origin: [process.env.CORS_ORIGIN || "http://localhost:5173"],
            additionalHeaders: ["cache-control", "x-requested-with", "authorization"],
            additionalExposedHeaders: ["content-type"],
        },
    },
    database: {
        path: process.env.DATABASE_PATH || "./messages.db",
    },
    socket: {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
    },
    cron: {
        schedule: process.env.CRON_SCHEDULE || '0 * * * *',
        retentionPeriodHours: process.env.RETENTION_PERIOD_HOURS || 48,
    },
};