import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import config from './config.js';

if (!config.jwt.jwksUri) {
    throw new Error(
        "Keycloak JWKS not configured. Set KEYCLOAK_JWKS_URI, or KEYCLOAK_URL + KEYCLOAK_REALM."
    );
}

const client = jwksClient({
    jwksUri: config.jwt.jwksUri,
    cache: true,
    rateLimit: true,
});

const getKey = (header) => {
    return new Promise((resolve, reject) => {
        client.getSigningKey(header.kid, (err, key) => {
            if (err) {
                reject(err);
            } else {
                const signingKey = key.publicKey || key.rsaPublicKey;
                resolve(signingKey);
            }
        });
    });
};

const authMiddleware = async (request, h) => {
    if (request.method.toLowerCase() === "options") {
        return h.continue;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
        return h.response({ status: 'error', message: 'No token provided' }).code(401).takeover();
    }

    const token = authHeader.split(' ')[1];

    try {
        const decodedHeader = jwt.decode(token, { complete: true });
        if (!decodedHeader) {
            return h.response({ status: 'error', message: 'Malformed token' }).code(401).takeover();
        }

        const key = await getKey(decodedHeader.header);
        const decoded = jwt.verify(token, key, { algorithms: ['RS256'] });

        // Optional realm-role gate (e.g. READ_SMS) matching the web app's access check.
        if (config.jwt.requiredRole) {
            const roles = decoded.realm_access?.roles || [];
            if (!roles.includes(config.jwt.requiredRole)) {
                return h
                    .response({ status: 'error', message: 'Insufficient role' })
                    .code(403)
                    .takeover();
            }
        }

        request.user = decoded;
        return h.continue;
    } catch (err) {
        console.log("Invalid token:", err.message);
        return h.response({ status: 'error', message: 'Invalid token' }).code(401).takeover();
    }
};

export default authMiddleware;
