const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

// Load Models
const User = require('./models/User');
const Vehicle = require('./models/Vehicle');
const Alert = require('./models/Alert');

dotenv.config();

const seedData = async () => {
  try {
    // 1. Connect to Database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('⏳ Seeding data...');

    // 2. Clear existing data
    await User.deleteMany();
    await Vehicle.deleteMany();
    await Alert.deleteMany();

    // 3. Create Admin User
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('admin123', salt);

    const admin = await User.create({
      name: 'NVIQ Admin',
      email: 'admin@nviq.com',
      password: hashedPassword,
      role: 'admin',
      companyName: 'NVIQ Fleet Management'
    });

    // 4. Create Sample Vehicles
    const vehicles = await Vehicle.create([
      {
        name: 'Heavy Truck 01',
        vehicleReg: 'ABC-1234',
        imei: '861234567890123',
        type: 'truck',
        status: 'moving',
        latitude: 24.8607, // Example: Karachi coordinates
        longitude: 67.0011,
        speed: 65,
        heading: 90
      },
      {
        name: 'Delivery Van 05',
        vehicleReg: 'XYZ-9876',
        imei: '861234567890456',
        type: 'van',
        status: 'parked',
        latitude: 24.8711,
        longitude: 67.0500,
        speed: 0,
        heading: 180
      }
    ]);

    // 5. Create Sample Alerts
    await Alert.create({
      vehicleId: vehicles[0]._id,
      vehicleName: vehicles[0].name,
      vehicleReg: vehicles[0].vehicleReg,
      title: 'Overspeeding',
      message: 'Vehicle exceeded 60km/h limit in city zone.',
      type: 'overspeed',
      priority: 'high',
      latitude: 24.8607,
      longitude: 67.0011,
      speed: 65
    });

    console.log('✅ Database Seeded Successfully!');
    process.exit();
  } catch (error) {
    console.error('❌ Error Seeding Data:', error.message);
    process.exit(1);
  }
};

seedData();