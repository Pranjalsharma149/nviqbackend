const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // We pass options to ensure stable connection
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
    });

    // Success Message (Cyan color)
    console.log(`\x1b[36m%s\x1b[0m`, `✨ MongoDB Connected: ${conn.connection.host}`);
    
    // Monitor connection events
    mongoose.connection.on('error', err => {
      console.error(`❌ MongoDB Runtime Error: ${err}`);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn(`⚠️ MongoDB Disconnected. Attempting to reconnect...`);
    });

  } catch (error) {
    // Error Message (Red color)
    console.error(`\x1b[31m%s\x1b[0m`, `❌ MongoDB Connection Error: ${error.message}`);
    
    // If DB fails, the whole app should stop
    process.exit(1);
  }
};

module.exports = connectDB;