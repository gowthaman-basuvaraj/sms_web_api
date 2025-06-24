import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import config from './config.js';

const client = jwksClient({
    jwksUri: config.jwt.jwksUri,
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
    const authHeader = request.headers.authorization;
    if(request.method.toLowerCase() === "options"){
        console.log('skipAuth check for Options')
        return h.continue;
    }
    if (!authHeader) {
        console.log("No token provided");
        return h.response({ status: 'error', message: 'No token provided' }).code(401).takeover();
    }

    const token = authHeader.split(' ')[1];
    // console.log("Token", token)

    try {
        let decoded0 = jwt.decode(token, { complete: true });
        console.log('decoded', decoded0)
        const key = await getKey(decoded0.header);
        const decoded = jwt.verify(token, key, { algorithms: ['RS256'] });
        console.log("Decoded Token:", decoded);
        request.user = decoded;
        return h.continue;
    } catch (err) {
        console.log("Invalid token:", err.message);
        return h.response({ status: 'error', message: 'Invalid token' }).code(401).takeover();
    }
};

export default authMiddleware;