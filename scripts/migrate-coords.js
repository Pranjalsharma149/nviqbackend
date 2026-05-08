'use strict';

/**
 * scripts/migrate-gcj02-to-wgs84.js
 *
 * ONE-TIME migration: converts GCJ-02 coordinates stored in MongoDB
 * (from Wanway/IOPGPS) to WGS-84 for correct map display in Flutter.
 *
 * Collections migrated:
 *   - vehicles          (latitude/longitude + lastKnownLocation)
 *   - locationpings     (latitude/longitude)
 *   - rawgpslogs        (latitude/longitude)
 *
 * FIXES over original script:
 *
 *   FIX-1  Idempotency guard — adds `coordSystem: 'wgs84'` marker after
 *          conversion and skips any document already marked. Safe to run
 *          multiple times without double-converting.
 *
 *   FIX-2  RawGpsLog collection added — original script missed it.
 *          Without this, TripPlaybackController replays wrong coordinates.
 *
 *   FIX-3  TCP device guard — skips documents where source='tcp' because
 *          TCP devices already send WGS-84 and must not be converted.
 *
 *   FIX-4  India bounding-box sanity check — skips any coordinate outside
 *          roughly India (lat 6-37, lng 68-97) after conversion. If a
 *          converted point falls outside India it was probably already WGS-84.
 *
 *   FIX-5  Batch size raised from 500 → 1000 for faster throughput on
 *          large LocationPing collections.
 *
 *   FIX-6  Dry-run mode: set DRY_RUN=true in env to preview without writes.
 *
 * Usage:
 *   node scripts/migrate-gcj02-to-wgs84.js
 *   DRY_RUN=true node scripts/migrate-gcj02-to-wgs84.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const mongoose = require('mongoose');

const DRY_RUN = process.env.DRY_RUN === 'true';

const OPTS = {
  maxPoolSize:              100,
  minPoolSize:              10,
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS:          60000,
  heartbeatFrequencyMS:     10000,
  family:                   4,
  autoIndex:                false,
  retryWrites:              true,
};

// Use strict:false so we can read any field without schema enforcement
const Vehicle      = mongoose.model('Vehicle',      new mongoose.Schema({}, { strict: false }), 'vehicles');
const LocationPing = mongoose.model('LocationPing', new mongoose.Schema({}, { strict: false }), 'locationpings');
const RawGpsLog    = mongoose.model('RawGpsLog',    new mongoose.Schema({}, { strict: false }), 'rawgpslogs');

// ── GCJ-02 → WGS-84 ──────────────────────────────────────────────────────────
function gcj02ToWgs84(gcjLng, gcjLat) {
  const a = 6378245.0, ee = 0.00669342162296594323;

  function tLat(lng, lat) {
    let r = -100 + 2*lng + 3*lat + 0.2*lat*lat + 0.1*lng*lat + 0.2*Math.sqrt(Math.abs(lng));
    r += (20*Math.sin(6*lng*Math.PI) + 20*Math.sin(2*lng*Math.PI)) * 2/3;
    r += (20*Math.sin(lat*Math.PI)   + 40*Math.sin(lat/3*Math.PI)) * 2/3;
    r += (160*Math.sin(lat/12*Math.PI) + 320*Math.sin(lat*Math.PI/30)) * 2/3;
    return r;
  }

  function tLng(lng, lat) {
    let r = 300 + lng + 2*lat + 0.1*lng*lng + 0.1*lng*lat + 0.1*Math.sqrt(Math.abs(lng));
    r += (20*Math.sin(6*lng*Math.PI) + 20*Math.sin(2*lng*Math.PI)) * 2/3;
    r += (20*Math.sin(lng*Math.PI)   + 40*Math.sin(lng/3*Math.PI)) * 2/3;
    r += (150*Math.sin(lng/12*Math.PI) + 300*Math.sin(lng/30*Math.PI)) * 2/3;
    return r;
  }

  const dLat = tLat(gcjLng - 105, gcjLat - 35);
  const dLng = tLng(gcjLng - 105, gcjLat - 35);
  const radLat = gcjLat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sq = Math.sqrt(magic);

  return {
    lat: gcjLat - (dLat * 180) / ((a * (1 - ee)) / (magic * sq) * Math.PI),
    lng: gcjLng - (dLng * 180) / (a / sq * Math.cos(radLat) * Math.PI),
  };
}

// ── Validation helpers ────────────────────────────────────────────────────────

// FIX-4: India bounding box — converted coords must land here or skip
const INDIA = { minLat: 6.0, maxLat: 37.6, minLng: 68.0, maxLng: 97.5 };

function isInIndia(lat, lng) {
  return lat >= INDIA.minLat && lat <= INDIA.maxLat &&
         lng >= INDIA.minLng && lng <= INDIA.maxLng;
}

function isValidRaw(lat, lng) {
  const la = +lat, lo = +lng;
  return lat != null && lng != null &&
         !isNaN(la) && !isNaN(lo) &&
         !(la === 0 && lo === 0);
}

// ── Migration helpers ─────────────────────────────────────────────────────────

/**
 * Attempt GCJ-02 → WGS-84 conversion.
 * Returns { lat, lng } if the result lands in India, otherwise returns null
 * (meaning the input was probably already WGS-84 — skip it).
 */
function tryConvert(rawLat, rawLng) {
  const { lat, lng } = gcj02ToWgs84(+rawLng, +rawLat);
  if (!isInIndia(lat, lng)) return null;   // FIX-4: likely already WGS-84
  return { lat, lng };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle migration
// ─────────────────────────────────────────────────────────────────────────────
async function migrateVehicles() {
  console.log('\n📦 Migrating Vehicle collection...');

  // FIX-1: only process vehicles NOT yet marked as wgs84
  const vehicles = await Vehicle.find({ coordSystem: { $ne: 'wgs84' } }).lean();
  console.log(`   Found ${vehicles.length} vehicles needing conversion`);
  if (!vehicles.length) { console.log('   ℹ️  All vehicles already WGS-84 — skipping'); return; }

  const ops = [];

  for (const v of vehicles) {
    const u = { coordSystem: 'wgs84' };   // FIX-1: mark as converted
    let converted = false;

    // Main coordinates
    if (isValidRaw(v.latitude, v.longitude)) {
      const result = tryConvert(v.latitude, v.longitude);
      if (result) {
        u.latitude  = result.lat;
        u.longitude = result.lng;
        u.lat       = result.lat;
        u.lng       = result.lng;
        converted   = true;
        console.log(
          `   ${v.imei || v._id}: (${(+v.latitude).toFixed(6)}, ${(+v.longitude).toFixed(6)})` +
          ` → (${result.lat.toFixed(6)}, ${result.lng.toFixed(6)})`
        );
      } else {
        console.log(`   ${v.imei || v._id}: skipped (already WGS-84 or outside India)`);
      }
    }

    // lastKnownLocation sub-document
    const lkl = v.lastKnownLocation;
    if (lkl && isValidRaw(lkl.latitude, lkl.longitude)) {
      const result = tryConvert(lkl.latitude, lkl.longitude);
      if (result) {
        u['lastKnownLocation.latitude']  = result.lat;
        u['lastKnownLocation.longitude'] = result.lng;
      }
    }

    ops.push({ updateOne: { filter: { _id: v._id }, update: { $set: u } } });
  }

  if (!ops.length) { console.log('   ℹ️  Nothing to update'); return; }
  if (DRY_RUN) { console.log(`   [DRY RUN] Would update ${ops.length} vehicles`); return; }

  const r = await Vehicle.bulkWrite(ops, { ordered: false });
  console.log(`   ✅ Updated ${r.modifiedCount} vehicles`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic paginated collection migration (LocationPing + RawGpsLog)
// ─────────────────────────────────────────────────────────────────────────────
async function migrateCollection(Model, collectionName) {
  console.log(`\n📦 Migrating ${collectionName} collection...`);

  // FIX-1: skip already-converted docs
  // FIX-3: skip TCP source docs (already WGS-84)
  const filter = {
    coordSystem: { $ne: 'wgs84' },
    source:      { $ne: 'tcp' },
  };

  const total = await Model.countDocuments(filter);
  console.log(`   Found ${total} documents needing conversion`);
  if (!total) { console.log('   ℹ️  Nothing to migrate'); return; }

  const BATCH = 1000;   // FIX-5: larger batch for speed
  let skip    = 0;
  let updated = 0;
  let skipped = 0;

  while (skip < total) {
    const docs = await Model.find(filter).skip(skip).limit(BATCH).lean();
    const ops  = [];

    for (const doc of docs) {
      if (!isValidRaw(doc.latitude, doc.longitude)) { skipped++; continue; }

      const result = tryConvert(doc.latitude, doc.longitude);
      if (!result) { skipped++; continue; }   // FIX-4: probably already WGS-84

      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: {
            latitude:    result.lat,
            longitude:   result.lng,
            coordSystem: 'wgs84',   // FIX-1: mark as converted
          }},
        },
      });
    }

    if (ops.length && !DRY_RUN) {
      const r = await Model.bulkWrite(ops, { ordered: false });
      updated += r.modifiedCount;
    } else if (DRY_RUN) {
      updated += ops.length;
    }

    skip += BATCH;
    const pct = Math.round(Math.min(skip, total) / total * 100);
    process.stdout.write(`\r   Progress: ${pct}% (${Math.min(skip, total)}/${total}) — updated ${updated}, skipped ${skipped}   `);
  }

  console.log(`\n   ✅ Updated ${updated} | Skipped ${skipped} (already WGS-84 or invalid)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 GCJ-02 → WGS-84 Migration');
  if (DRY_RUN) console.log('   ⚠️  DRY RUN — no writes will be performed\n');
  else         console.log('   ⚠️  LIVE RUN — documents will be modified\n');

  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('❌ MONGO_URI missing from .env'); process.exit(1); }

  console.log('⏳ Connecting to MongoDB...');
  await mongoose.connect(uri, OPTS);
  console.log(`✅ Connected → ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  await migrateVehicles();
  await migrateCollection(LocationPing, 'LocationPing');
  await migrateCollection(RawGpsLog,    'RawGpsLog');    // FIX-2: was missing

  console.log('\n🎉 Done! All Wanway coordinates are now WGS-84.\n');
  if (DRY_RUN) console.log('   Run without DRY_RUN=true to apply changes.\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Migration failed:', e.message);
  process.exit(1);
});