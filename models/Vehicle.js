
const mongoose = require('mongoose');

const vehicleSchema = mongoose.Schema({
  name: { 
    type: String, 
    required: true 
  },
  plateNumber: { 
    type: String, 
    required: true, 
    unique: true 
  },
  // Correctly set to Number to match Traccar's Internal ID
  traccarDeviceId: { 
    type: Number, 
    required: true, 
    unique: true 
  },
  // Added Category for UI icon selection in Flutter
  category: { 
    type: String, 
    enum: ['car', 'truck', 'bike', 'van'], 
    default: 'car' 
  },
  status: { 
    type: String, 
    enum: ['online', 'offline', 'moving', 'unknown'], 
    default: 'unknown' 
  },
  latitude: { type: Number },
  longitude: { type: Number },
  speed: { type: Number, default: 0 },
  lastUpdate: { type: Date }
}, { 
  timestamps: true 
});

module.exports = mongoose.model('Vehicle', vehicleSchema);