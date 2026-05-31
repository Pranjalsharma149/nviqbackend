'use strict';

/**
 * scripts/backfillHistory.js
 *
 * Backfills History collection for all vehicles in the database for the past N days.
 *
 * Usage:
 *   node scripts/backfillHistory.js --days=30
 */

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Vehicle = require('../models/Vehicle');
const History = require('../models/History');
const { generateHistoryDoc } = require('../controllers/historyController');
const { utcDayStart } = require('../services/analytics.service');

async function backfill() {
  // Parse command line arguments
  let daysToBackfill = 30;
  const daysArg = process.argv.find(arg => arg.startsWith('--days='));
  if (daysArg) {
    const val = parseInt(daysArg.split('=')[1], 10);
    if (!isNaN(val) && val > 0) {
      daysToBackfill = val;
    }
  }

  console.log(`🚀 Starting History backfill for the past ${daysToBackfill} days...`);

  // 1. Fetch all vehicles
  const vehicles = await Vehicle.find({}).select('_id imei name').lean();
  if (vehicles.length === 0) {
    console.log('⚠️ No vehicles found in database.');
    return;
  }

  console.log(`📦 Found ${vehicles.length} vehicles to process.`);

  const todayStart = utcDayStart(new Date());

  // Loop through each vehicle
  for (const vehicle of vehicles) {
    console.log(`\n🚙 Processing vehicle: ${vehicle.name || 'Unnamed'} (IMEI: ${vehicle.imei || 'N/A'}, ID: ${vehicle._id})`);

    let processed = 0;
    let cached = 0;
    let errors = 0;

    // Loop through the past N days (skipping today as it is dynamic)
    for (let i = 1; i <= daysToBackfill; i++) {
      const targetDate = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = targetDate.toISOString().split('T')[0];

      try {
        // Check if history already exists for this date
        const existing = await History.findOne({ vehicleId: vehicle._id, date: targetDate }).lean();
        if (existing) {
          cached++;
          continue; // Already processed and cached
        }

        // Generate history document
        const historyDoc = await generateHistoryDoc(vehicle._id, vehicle.imei, targetDate);

        // Save history (only if there was distance covered to avoid bloated empty logs)
        if (historyDoc.distance > 0 || historyDoc.trips.length > 0) {
          await History.findOneAndUpdate(
            { vehicleId: vehicle._id, date: targetDate },
            { $set: historyDoc },
            { upsert: true, new: true }
          );
          processed++;
        } else {
          cached++; // Skipped because no data, count as cached/done
        }
      } catch (err) {
        errors++;
        console.error(`  ❌ Failed for date ${dateStr}: ${err.message}`);
      }
    }

    console.log(`  📊 Summary: ${processed} backfilled, ${cached} skipped/already cached, ${errors} errors.`);
  }

  console.log('\n✅ Backfill process completed successfully!');
}

// Execute
if (require.main === module) {
  require('dotenv').config();

  connectDB()
    .then(backfill)
    .then(() => {
      console.log('🏁 Process finished.');
      process.exit(0);
    })
    .catch(e => {
      console.error(`💥 Fatal Error: ${e.message}`);
      process.exit(1);
    });
}

module.exports = backfill;
