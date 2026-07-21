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

/**
 * Verifies a Keycloak access token (signature, issuer if configured) and, when a required
 * role is configured, that the token carries it. Returns the decoded payload or throws.
 * Shared by the HTTP middleware and the socket handshake so both channels are authed.
 */
export async function authenticateToken(token) {
    const decodedHeader = jwt.decode(token, { complete: true });
    if (!decodedHeader) {
        throw new Error("Malformed token");
    }

    const key = await getKey(decodedHeader.header);
    const verifyOptions = { algorithms: ['RS256'] };
    if (config.jwt.issuer) {
        verifyOptions.issuer = config.jwt.issuer;
    }
    const decoded = jwt.verify(token, key, verifyOptions);

    if (config.jwt.requiredRole) {
        const roles = decoded.realm_access?.roles || [];
        if (!roles.includes(config.jwt.requiredRole)) {
            const err = new Error("Insufficient role");
            err.statusCode = 403;
            throw err;
        }
    }

    return decoded;
}

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
        request.user = await authenticateToken(token);
        return h.continue;
    } catch (err) {
        if (err.statusCode === 403) {
            return h.response({ status: 'error', message: 'Insufficient role' }).code(403).takeover();
        }
        console.log("Invalid token:", err.message);
        return h.response({ status: 'error', message: 'Invalid token' }).code(401).takeover();
    }
};

export default authMiddleware;
