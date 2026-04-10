const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');
const { logger } = require('./middleware/loggerMiddleware');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { initBridge } = require('./utils/apiBridge');

// 1. Load Environment Variables
dotenv.config();

// 2. Connect to MongoDB
connectDB();

const app = express();
const server = http.createServer(app);

// 3. Initialize Socket.io for Real-Time Map Updates
const io = socketio(server, {
  cors: {
    origin: "*", // Adjust for production security
    methods: ["GET", "POST"]
  }
});

// Make io accessible to our controllers and utils (like apiBridge)
app.set('io', io);

// 4. Global Middlewares
app.use(cors()); 
app.use(express.json()); // Essential for parsing JSON bodies
app.use(express.urlencoded({ extended: true })); // Parsers for form-data
app.use(logger); 

// 5. Mount Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/vehicles', require('./routes/vehicleRoutes'));
app.use('/api/tracking', require('./routes/trackingRoutes'));
app.use('/api/alerts', require('./routes/alertRoutes'));
app.use('/api/tickets', require('./routes/ticketRoutes'));

// 6. Root Route (Health Check)
app.get('/', (req, res) => {
  res.send('NVIQ Fleet Management API is running...');
});

// 7. Initialize the API Bridge (Auto-sync GPS data)
initBridge(app);

// 8. Socket.io Connection Logic
io.on('connection', (socket) => {
  console.log(`🔌 New WebSocket Connection: ${socket.id}`);

  socket.on('joinFleet', (companyId) => {
    socket.join(companyId);
    console.log(`🏢 Client joined company room: ${companyId}`);
  });

  socket.on('disconnect', () => {
    console.log('🔌 User disconnected from WebSocket');
  });
});

// 9. Error Handling Middleware (Must be last)
app.use(notFound);
app.use(errorHandler);

// 10. Start Server
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

server.listen(PORT, () => {
  console.log(`🚀 Server running in ${NODE_ENV} mode on port ${PORT}`);
});