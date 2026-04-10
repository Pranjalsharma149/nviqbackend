const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
    // 1. Bypass check for development
    if (process.env.SKIP_AUTH === 'true') {
        return next();
    }

    let token;

    // 2. Check if token exists in headers (Authorization: Bearer <token>)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            // Get token from header
            token = req.headers.authorization.split(' ')[1];

            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Get user from the token (but don't get the password)
            req.user = await User.findById(decoded.id).select('-password');

            return next();
        } catch (error) {
            console.error("❌ Auth Middleware Error:", error.message);
            return res.status(401).json({ message: "Not authorized, token failed" });
        }
    }

    if (!token) {
        return res.status(401).json({ message: "Not authorized, no token provided" });
    }
};

module.exports = { protect };