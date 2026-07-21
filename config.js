// JWKS endpoint used to verify incoming Keycloak tokens. Provide it directly via
// KEYCLOAK_JWKS_URI, or let it be derived from KEYCLOAK_URL + KEYCLOAK_REALM. Without one
// of these, token verification cannot work and the server refuses to start (see
// authMiddleware.js) — previously this was a hardcoded '<insert>' placeholder.
const keycloakUrl = process.env.KEYCLOAK_URL;
const keycloakRealm = process.env.KEYCLOAK_REALM;
const derivedJwksUri =
  keycloakUrl && keycloakRealm
    ? `${keycloakUrl.replace(/\/$/, "")}/realms/${keycloakRealm}/protocol/openid-connect/certs`
    : undefined;

export default {
    jwt: {
        jwksUri: process.env.KEYCLOAK_JWKS_URI || derivedJwksUri,
        // Optional realm role required to access the API. When unset, any valid token is
        // accepted; when set (e.g. READ_SMS), callers must hold that realm role.
        requiredRole: process.env.REALM_ACCESS || null,
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
