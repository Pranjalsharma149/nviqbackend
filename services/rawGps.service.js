'use strict';

/**
 * services/rawGps.service.js
 *
 * BULK RAW GPS STORAGE LAYER
 *
 * Sits between wanway.poller.js and data.processor.js.
 * Sole responsibility: persist normalised GPS payloads into RawGpsLog
 * as fast as possible using insertMany with ordered:false.
 *
 * Duplicate detection is TWO-TIER:
 *   Tier 1 (in-memory, per process) — nanosecond, blocks most dupes
 *   Tier 2 (DB unique index)        — catches cross-process / restart dupes
 *                                     (index: imei + gpsTimestamp + lat + lng)
 *
 * Points are NEVER dropped — isDuplicate flag is set instead so the
 * analytics pipeline can choose to exclude or include them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * USAGE (in wanway.poller.js):
 *
 *   const { saveRawBatch } = require('./rawGps.service');
 *
 *   const normalized = normalizeDevices(rawDevices);
 *   await saveRawBatch(normalized, 'wanway');      // ← NEW: persist raw
 *   await processBulkUpdates(normalized, 'wanway'); // existing processor
 * ────────────────────────────────────────────────────────────────────────────
 */

const logger    = require('../utils/logger');
const RawGpsLog = require('../models/RawGpsLog');
const Vehicle   = require('../models/Vehicle');
const { haversineKm } = require('../utils/distance');

// ── Duplicate detection config ────────────────────────────────────────────────
const DEDUP_WINDOW_MS   = 5_000;    // 5 seconds
const DEDUP_MIN_DIST_KM = 0.010;    // 10 metres

// In-memory last-seen per IMEI: imei → { lat, lng, tsMs }
const _lastSeen = new Map();

/**
 * Mark a point duplicate if it arrived within DEDUP_WINDOW_MS of the
 * previous stored point AND is closer than DEDUP_MIN_DIST_KM.
 * Then update the in-memory cache regardless.
 *
 * @param {string} imei
 * @param {number} lat
 * @param {number} lng
 * @param {number} tsMs  Unix ms (GPS timestamp)
 * @returns {boolean}
 */
function _checkAndMarkDuplicate(imei, lat, lng, tsMs) {
  const prev = _lastSeen.get(imei);

  let isDuplicate = false;

  if (prev) {
    const ageDiff = tsMs - prev.tsMs;
    if (ageDiff >= 0 && ageDiff < DEDUP_WINDOW_MS) {
      const distKm = haversineKm(prev.lat, prev.lng, lat, lng);
      if (distKm < DEDUP_MIN_DIST_KM) {
        isDuplicate = true;
      }
    }
  }

  // Always update cache so we always compare against the most recent point
  _lastSeen.set(imei, { lat, lng, tsMs });

  return isDuplicate;
}

// ── IMEI → vehicleId cache (refreshed every 5 minutes) ───────────────────────
let _vehicleCache       = new Map();   // imei → vehicleId (ObjectId)
let _vehicleCacheExpiry = 0;
const VEHICLE_CACHE_TTL = 5 * 60_000; // 5 minutes

async function _getVehicleMap() {
  if (Date.now() < _vehicleCacheExpiry && _vehicleCache.size > 0) {
    return _vehicleCache;
  }

  const vehicles = await Vehicle.find({}).select('_id imei').lean();
  _vehicleCache  = new Map(vehicles.map(v => [String(v.imei), v._id]));
  _vehicleCacheExpiry = Date.now() + VEHICLE_CACHE_TTL;

  logger.debug('[RawGpsService] Vehicle cache refreshed (%d entries)', _vehicleCache.size);
  return _vehicleCache;
}

// ── GCJ-02 → WGS-84 (inline copy so this service is self-contained) ───────────
function _gcj02ToWgs84(gcjLng, gcjLat) {
  const a  = 6378245.0;
  const ee = 0.00669342162296594323;

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

  const dLat      = tLat(gcjLng - 105, gcjLat - 35);
  const dLng      = tLng(gcjLng - 105, gcjLat - 35);
  const radLat    = gcjLat / 180 * Math.PI;
  let   magic     = Math.sin(radLat);
  magic           = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  return {
    lat: gcjLat - (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI),
    lng: gcjLng - (dLng * 180) / (a / sqrtMagic * Math.cos(radLat) * Math.PI),
  };
}

// ── Normalise a single device payload into a RawGpsLog document ───────────────
/**
 * Converts a device record (already normalised by wanway.poller.normalizeDevices)
 * into the shape expected by RawGpsLog.create / insertMany.
 *
 * @param {Object}  dev          Normalised device object from poller
 * @param {string}  source       'wanway' | 'tcp' | 'multitrack'
 * @param {Map}     vehicleMap   imei → ObjectId
 * @returns {{ doc: Object|null, imei: string }}
 */
function _buildDocument(dev, source, vehicleMap) {
  const imei = String(dev.imei || '').trim();
  if (!imei) return { doc: null, imei: '' };

  const vehicleId = vehicleMap.get(imei);
  if (!vehicleId) {
    // Unknown device — log once then skip
    logger.warn('[RawGpsService] Unknown IMEI=%s — not in vehicle DB, skipping raw log', imei);
    return { doc: null, imei };
  }

  // ── Resolve coordinates ───────────────────────────────────────────────────
  let lat = dev.lat  != null ? parseFloat(dev.lat)  : null;
  let lng = dev.lng  != null ? parseFloat(dev.lng)  : null;

  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    return { doc: null, imei };
  }

  if (lat === 0 && lng === 0) return { doc: null, imei };   // Null-island

  // WanWay: GCJ-02 → WGS-84. TCP/MultiTrack: already WGS-84.
  if (source === 'wanway') {
    const wgs = _gcj02ToWgs84(lng, lat);
    lat = wgs.lat;
    lng = wgs.lng;
  }

  // ── Timestamps ────────────────────────────────────────────────────────────
  const now        = new Date();
  const gpsTs      = dev.gpsTime    ? new Date(dev.gpsTime    * 1000) : now;
  const serverTs   = dev.signalTime ? new Date(dev.signalTime * 1000) : now;

  // ── Duplicate detection ───────────────────────────────────────────────────
  const isDuplicate = _checkAndMarkDuplicate(imei, lat, lng, gpsTs.getTime());

  // ── Speed / status ────────────────────────────────────────────────────────
  const speed   = parseFloat(dev.speed  ?? 0);
  const isOnline = (Date.now() - serverTs.getTime()) < 5 * 60_000;
  const status  = !isOnline ? 'offline' : speed > 5 ? 'moving' : 'idle';

  return {
    imei,
    doc: {
      imei,
      vehicleId,
      latitude:        lat,
      longitude:       lng,
      speed,
      heading:         parseFloat(dev.course ?? dev.heading ?? 0),
      ignition:        dev.acc != null ? Boolean(dev.acc) : null,
      status,
      source,
      gpsTimestamp:    gpsTs,
      serverTimestamp: serverTs,
      satellites:      parseInt(dev.satellites ?? 0, 10),
      accuracy:        parseFloat(dev.accuracy ?? 0),
      voltage:         dev.extVoltage != null ? dev.extVoltage / 10 : null,
      odometer:        dev.odometer ?? dev.mileage ?? null,
      isDuplicate,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveRawBatch — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a batch of normalised GPS records into RawGpsLog.
 *
 * - Uses insertMany with ordered:false so a single duplicate key error
 *   does not abort the whole batch.
 * - Non-blocking: the returned Promise resolves after the DB write but
 *   callers (poller) should not await if they don't want to add latency.
 * - Returns a stats object for observability.
 *
 * @param {Array}  devices  Normalised records from wanway.poller.normalizeDevices()
 * @param {string} source   'wanway' | 'tcp' | 'multitrack'
 * @returns {Promise<{ inserted: number, duplicates: number, skipped: number }>}
 */
async function saveRawBatch(devices, source = 'wanway') {
  if (!Array.isArray(devices) || devices.length === 0) {
    return { inserted: 0, duplicates: 0, skipped: 0 };
  }

  const vehicleMap = await _getVehicleMap();
  const now        = Date.now();

  const docs       = [];
  let   skipped    = 0;
  let   duplicates = 0;

  for (const dev of devices) {
    const { doc, imei } = _buildDocument(dev, source, vehicleMap);

    if (!doc) {
      skipped++;
      continue;
    }

    if (doc.isDuplicate) duplicates++;
    docs.push(doc);
  }

  if (docs.length === 0) {
    logger.debug('[RawGpsService] No valid docs to insert (skipped=%d)', skipped);
    return { inserted: 0, duplicates, skipped };
  }

  // ── Bulk insert ───────────────────────────────────────────────────────────
  // ordered:false  → continue inserting even if some docs hit duplicate key
  // rawResult:true → get the low-level result with nInserted
  let inserted = 0;
  try {
    const result = await RawGpsLog.insertMany(docs, {
      ordered:   false,
      rawResult: true,
    });
    inserted = result.mongoose?.insertedCount ?? docs.length;
  } catch (err) {
    // BulkWriteError (code 11000) means some docs were duplicate-key —
    // the rest were still inserted when ordered:false.
    if (err.name === 'BulkWriteError' || err.code === 11000) {
      inserted = err.result?.nInserted ?? 0;
      logger.debug(
        '[RawGpsService] BulkWrite partial: inserted=%d, dupKey=%d',
        inserted, err.result?.nWriteErrors ?? 0
      );
    } else {
      logger.error('[RawGpsService] insertMany error: %s', err.message);
    }
  }

  const elapsed = Date.now() - now;
  logger.info(
    '💾 [RawGpsService] Batch saved | src=%s | total=%d inserted=%d dup=%d skip=%d | %dms',
    source, devices.length, inserted, duplicates, skipped, elapsed
  );

  return { inserted, duplicates, skipped };
}

// ── saveRawSingle — convenience wrapper for TCP (single device at a time) ─────
/**
 * @param {Object} device  Single normalised device record
 * @param {string} source  'tcp' | 'wanway' | 'multitrack'
 */
async function saveRawSingle(device, source = 'tcp') {
  return saveRawBatch([device], source);
}

module.exports = {
  saveRawBatch,
  saveRawSingle,
};