// scripts/seedDevices.js
//
// Called automatically at server boot.
// Creates a Vehicle document in MongoDB for every device in config/devices.js
// If vehicle already exists (matched by IMEI) — skips it, no duplicate.
// Run manually: node scripts/seedDevices.js

'use strict';

async function seedDevices() {
  const Vehicle = require('../models/Vehicle');
  const { REGISTERED_DEVICES } = require('../config/devices');

  let created = 0, skipped = 0;

  for (const d of REGISTERED_DEVICES) {
    try {
      // Check by IMEI first, then by vehicleReg
      const exists = await Vehicle.findOne({
        $or: [
          { imei: d.imei },
          { vehicleReg: d.vehicleReg.toUpperCase() },
        ],
      });

      if (exists) {
        // Update IMEI if missing (handles vehicles registered without IMEI)
        if (!exists.imei && d.imei) {
          await Vehicle.findByIdAndUpdate(exists._id, { imei: d.imei, protocol: d.protocol || 'GT06' });
          console.log(`🔗 Linked IMEI ${d.imei} → ${exists.name}`);
        } else {
          console.log(`⏭  Already exists: ${d.name} (${d.imei})`);
        }
        skipped++;
        continue;
      }

      await Vehicle.create({
        imei:        d.imei,
        vehicleReg:  d.vehicleReg.toUpperCase(),
        name:        d.name,
        type:        d.type        || 'car',
        protocol:    d.protocol    || 'GT06',
        pocName:     d.pocName     || '',
        pocContact:  d.pocContact  || '',
        latitude:    28.6139,    // Delhi — updates on first GPS ping
        longitude:   77.2090,
        speed:       0,
        heading:     0,
        fuel:        100,
        batteryLevel:100,
        gpsSignal:   false,
        status:      'offline',
        isLive:      false,
        isOnline:    false,
        lastUpdate:  new Date(),
      });

      console.log(`✅ Created vehicle: ${d.name} (IMEI: ${d.imei})`);
      created++;
    } catch (e) {
      console.error(`❌ Failed to seed ${d.imei}:`, e.message);
    }
  }

  if (created > 0 || skipped > 0) {
    console.log(`📦 Seed complete — created: ${created}, skipped: ${skipped}`);
  }
}

// Allow running directly: node scripts/seedDevices.js
if (require.main === module) {
  require('dotenv').config();
  const connectDB = require('../config/db');
  connectDB()
    .then(seedDevices)
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = seedDevices;