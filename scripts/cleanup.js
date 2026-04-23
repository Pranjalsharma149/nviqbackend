'use strict';
require('dotenv').config();
const connectDB = require('../config/db');
const Vehicle = require('../models/Vehicle');

async function cleanup() {
  await connectDB();
  const result = await Vehicle.deleteMany({
    imei: { $nin: ['356218606576971'] }
  });
  console.log(`✅ Deleted ${result.deletedCount} fake vehicles`);
  process.exit(0);
}

cleanup().catch(e => {
  console.error('❌ Failed:', e.message);
  process.exit(1);
});