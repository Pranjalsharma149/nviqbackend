/**
 * @desc    Log every incoming request to the console
 * @usage   Helps track Postman hits and Flutter API calls
 */
const logger = (req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const url = req.url;

    // We use some basic spacing to make the terminal output clean
    console.log(`[${timestamp}] ${method.padEnd(7)} ${url}`);
    
    next();
};

module.exports = { logger };