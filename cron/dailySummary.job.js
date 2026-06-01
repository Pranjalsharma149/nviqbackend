'use strict';

/**
 * cron/dailySummary.job.js
 *
 * Nightly cron that computes and stores DailySummary for every vehicle.
 * By pre-computing yesterday's numbers, the analytics API can serve
 * historical queries in milliseconds without scanning RawGpsLog.
 *
 * Schedule: 00:05 UTC daily (5 min after midnight so all data is in)
 *
 * Usage:
 *   In server.js / boot():
 *     require('./cron/dailySummary.job').start();
 *
 * Standalone run (backfill):
 *   node -e "require('./cron/dailySummary.job').runForDate('2025-07-14')"
 */

const cron = require('node-cron');

const Vehicle = require('../models/Vehicle');
const DailySummary = require('../models/DailySummary');
const Trip = require('../models/Trip');
const logger = require('../utils/logger');

const {
  computeDailyFromRaw,
  utcDayStart,
  utcDayEnd,
} = require('../services/analytics.service');

// ── runForDate ────────────────────────────────────────────────────────────────
/**
 * Computes and upserts DailySummary for every active vehicle for a given date.
 *
 * @param {string|Date} dateInput  'YYYY-MM-DD' or Date object
 */
async function runForDate(dateInput) {
  const from = utcDayStart(dateInput);
  const to = utcDayEnd(dateInput);
  const dateStr = from.toISOString().split('T')[0];

  logger.info('📊 [DailySummaryJob] Starting for date=%s', dateStr);
  const jobStart = Date.now();

  // Fetch all vehicles (only _id and imei needed)
  const vehicles = await Vehicle.find({}).select('_id imei').lean();
  if (vehicles.length === 0) {
    logger.warn('⚠️  [DailySummaryJob] No vehicles found');
    return;
  }

  logger.info('📊 [DailySummaryJob] Processing %d vehicles', vehicles.length);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  // Process in batches to avoid OOM
  const BATCH = 20;
  for (let i = 0; i < vehicles.length; i += BATCH) {
    const chunk = vehicles.slice(i, i + BATCH);

    await Promise.allSettled(
      chunk.map(async (v) => {
        try {
          // Compute from raw data
          const stats = await computeDailyFromRaw(v._id, from, to);

          if (stats.rawPointCount === 0) {
            skipCount++;
            return;   // No data for this vehicle on this day
          }

          // Trip count for the day
          const tripCount = await Trip.countDocuments({
            vehicleId: v._id,
            isCompleted: true,
            startTime: { $gte: from, $lte: to },
          });

          // Upsert — replaces any previous run for this vehicle+date
          await DailySummary.findOneAndUpdate(
            { vehicleId: v._id, date: from },
            {
              $set: {
                vehicleId: v._id,
                imei: v.imei,
                date: from,
                totalDistance: stats.totalDistance,
                engineOnSeconds: stats.engineOnSeconds,
                runningSeconds: stats.runningSeconds,
                idleSeconds: stats.idleSeconds,
                engineHours: stats.engineHours,
                runningHours: stats.runningHours,
                idleHours: stats.idleHours,
                maxSpeed: stats.maxSpeed,
                avgSpeed: stats.avgSpeed,
                tripCount,
                rawPointCount: stats.rawPointCount,
                generatedAt: new Date(),
                isPartial: false,
              },
            },
            { upsert: true, new: true }
          );

          // ── AUTOMATED HISTORY GENERATION ────────────────────────────────────
          // Also pre-compute and store the History document for this day
          const History = require('../models/History');
          const { generateHistoryDoc } = require('../controllers/historyController');
          const historyDoc = await generateHistoryDoc(v._id, v.imei, from);

          await History.findOneAndUpdate(
            { vehicleId: v._id, date: from },
            { $set: historyDoc },
            { upsert: true }
          );

          successCount++;

          logger.debug(
            '📊 [DailySummaryJob] IMEI=%s | dist=%.2f km | eng=%.2fh | trips=%d',
            v.imei, stats.totalDistance, stats.engineHours, tripCount
          );
        } catch (err) {
          errorCount++;
          logger.error(
            '❌ [DailySummaryJob] Failed for IMEI=%s date=%s: %s',
            v.imei, dateStr, err.message
          );
        }
      })
    );
  }

  const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
  logger.info(
    '✅ [DailySummaryJob] Done for %s | ok=%d skip=%d err=%d | %.1fs',
    dateStr, successCount, skipCount, errorCount, elapsed
  );
}

// ── runYesterday ──────────────────────────────────────────────────────────────
async function runYesterday() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await runForDate(yesterday);
}

// ── backfill ──────────────────────────────────────────────────────────────────
/**
 * Backfill summaries for the past N days (useful when first deploying).
 * Call manually: require('./cron/dailySummary.job').backfill(30)
 *
 * @param {number} days  how many past days to process (max 90)
 */
async function backfill(days = 30) {
  const limit = Math.min(days, 90);
  logger.info('📊 [DailySummaryJob] Backfill started for past %d days', limit);

  for (let i = 1; i <= limit; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    await runForDate(d);
  }

  logger.info('✅ [DailySummaryJob] Backfill complete');
}


// ── resetTodayIdleTime ────────────────────────────────────────────────────────
async function resetTodayIdleTime() {
  try {
    const result = await Vehicle.updateMany(
      {},
      {
        $set: {
          todayIdleTime: 0,
          todayIdleResetAt: new Date(),
        },
      }
    );
    logger.info('🔄 [DailySummaryJob] todayIdleTime reset for %d vehicles', result.modifiedCount);
  } catch (err) {
    logger.error('❌ [DailySummaryJob] todayIdleTime reset failed: %s', err.message);
  }
}



// ── archiveOldRawLogs ─────────────────────────────────────────────────────────
/**
 * Optional: delete RawGpsLog entries older than ARCHIVE_DAYS.
 * Only runs if ARCHIVE_RAW_LOGS=true in env.
 * Run after daily summary is confirmed generated.
 */
async function archiveOldRawLogs() {
  if (process.env.ARCHIVE_RAW_LOGS !== 'true') return;

  const RawGpsLog = require('../models/RawGpsLog');
  const archiveDays = parseInt(process.env.ARCHIVE_RAW_DAYS ?? '90', 10);
  const cutoff = new Date(Date.now() - archiveDays * 24 * 60 * 60 * 1000);

  logger.info(
    '🗑️  [DailySummaryJob] Archiving raw logs older than %s',
    cutoff.toISOString()
  );

  try {
    const result = await RawGpsLog.deleteMany({ serverTimestamp: { $lt: cutoff } });
    logger.info('🗑️  [DailySummaryJob] Deleted %d old raw logs', result.deletedCount);
  } catch (err) {
    logger.error('❌ [DailySummaryJob] Archive error: %s', err.message);
  }
}

// ── Cron schedule ─────────────────────────────────────────────────────────────
//   "5 0 * * *"  = 00:05 UTC every day
let _cronTask = null;

function start() {
  if (_cronTask) {
    logger.warn('⚠️  [DailySummaryJob] Already running');
    return;
  }

  _cronTask = cron.schedule('5 0 * * *', async () => {
    logger.info('⏰ [DailySummaryJob] Cron triggered');
    try {
      await runYesterday();
      await resetTodayIdleTime(); // reset daily idle hours
      await archiveOldRawLogs();
    } catch (err) {
      logger.error('❌ [DailySummaryJob] Cron run failed: %s', err.message);
    }
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  logger.info('⏰ [DailySummaryJob] Scheduled (daily at 00:05 UTC)');
}

function stop() {
  if (_cronTask) {
    _cronTask.stop();
    _cronTask = null;
    logger.info('⏹️  [DailySummaryJob] Stopped');
  }
}

module.exports = {
  start,
  stop,
  runForDate,
  runYesterday,
  backfill,
};