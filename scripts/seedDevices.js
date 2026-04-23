'use strict';

async function seedDevices() {
  const Vehicle = require('../models/Vehicle');
  const { REGISTERED_DEVICES } = require('../config/devices');

  if (!REGISTERED_DEVICES || REGISTERED_DEVICES.length === 0) {
    console.warn('⚠️ No devices found in config/devices.js to seed.');
    return;
  }

  console.log(`🚀 Preparing bulk seed for ${REGISTERED_DEVICES.length} devices...`);

  const ops = REGISTERED_DEVICES.map(d => ({
    updateOne: {
      filter: { imei: d.imei },
      update: {
        // $setOnInsert only runs when a NEW device is created (upsert)
        // Never overwrites live telemetry on existing devices
        $setOnInsert: {
          vehicleReg:  d.vehicleReg.toUpperCase(),
          name:        d.name,
          type:        d.type     || 'car',
          protocol:    d.protocol || 'WanWay',
          pocName:     d.pocName  || '',
          pocContact:  d.pocContact || '',
          // ✅ No Delhi defaults — null means "not yet received from device"
          // IOPGPS will populate real coords on the first poll
          latitude:    null,
          longitude:   null,
          status:      'offline',
          isOnline:    false,
          isLive:      false,
          lastUpdate:  new Date(),
        }
      },
      upsert: true
    }
  }));

  try {
    const result = await Vehicle.bulkWrite(ops, { ordered: false });

    console.log('--- 📦 Bulk Seed Summary ---');
    console.log(` ✅ Matched:  ${result.matchedCount}`);
    console.log(` ✅ Upserted: ${result.upsertedCount} (New devices added)`);
    console.log(` ✅ Modified: ${result.modifiedCount} (Existing devices updated)`);
    console.log('---------------------------');
  } catch (e) {
    console.error('❌ Bulk seed failed:', e.message);
  }
}

// Support for direct execution
if (require.main === module) {
  require('dotenv').config();
  const connectDB = require('../config/db');

  connectDB()
    .then(seedDevices)
    .then(() => {
      console.log('🏁 Seeding process finished.');
      process.exit(0);
    })
    .catch(e => {
      console.error(`💥 Fatal Error: ${e.message}`);
      process.exit(1);
    });
}

module.exports = seedDevices;