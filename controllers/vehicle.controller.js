'use strict';

/**
 * controllers/vehicle.controller.js
 *
 * REST API controller for all vehicle-related endpoints.
 *
 * FIXES applied to align with Flutter live_tracking_screen.dart:
 *
 *   FIX-1  getMileageReport: returns todayDistanceKm, dailyDistance, distanceToday
 *          as SEPARATE fields from totalDistanceKm (odometer). Was reading same
 *          field for both, causing Flutter to show wrong "Today Dist" value.
 *
 *   FIX-2  getMileageReport: returns engineHours, totalEngineHours, runningHours
 *          so Flutter _fetchWanwayDataForVehicle() finds the field regardless of
 *          which alias it tries first.
 *
 *   FIX-3  normalise(): emits ignitionOn AND ignition so Flutter's _parseBoolField
 *          catches it on both 'ignitionOn' and 'ignition' keys.
 *
 *   FIX-4  getMileageReport: totalDistanceKm / odometer / odometerKm are now taken
 *          from the ODOMETER field, never conflated with today's distance.
 *
 *   FIX-5  normalise(): batteryVoltage AND voltage both emitted so Flutter's
 *          _firstDouble finds it regardless of which alias it uses.
 *
 *   FIX-6  getDeviceInfo: returns activationTime, registrationTime, installDate,
 *          createdAt, firstSeen, addTime so Flutter _fetchInstallDate() finds one.
 *
 *   FIX-7  normalise(): vehicleTypeKey added (Flutter uses vehicleTypeKey, not type).
 *
 *   FIX-8  normalise(): todayDistanceKm, totalDistanceKm, engineHoursToday all
 *          exposed at top level so Flutter _VState seeding reads them immediately.
 *
 *   FIX-9  getMileageReport: falls back to computing from RawGpsLog when
 *          DailySummary is missing AND analytics.service is unavailable —
 *          returns zero-valued object instead of throwing.
 *
 *   FIX-10 normalise(): lastGpsTime added as alias for lastUpdate so Flutter
 *          _loadLastFixTimes() can read it from the summaries map.
 */

const mongoose     = require('mongoose');
const Vehicle      = require('../models/Vehicle');
const DailySummary = require('../models/DailySummary');
const RawGpsLog    = require('../models/RawGpsLog');
const Alert        = require('../models/Alert');
const logger       = require('../utils/logger');

// ── Field selector ────────────────────────────────────────────────────────────
const VEHICLE_FIELDS = [
  'name', 'vehicleReg', 'imei', 'type', 'protocol',
  'status', 'isOnline', 'isLive',
  'latitude', 'longitude', 'speed', 'heading',
  'ignition', 'voltage', 'satellites', 'accuracy', 'odometer',
  'address', 'lastUpdate', 'lastKnownLocation',
  'todayDistance', 'todayEngineHours', 'todayMaxSpeed',
  'pocName', 'pocContact', 'speedLimit',
  'analytics', 'userId',
].join(' ');

// ── Normalise → Flutter VehicleModel fields ───────────────────────────────────
/**
 * Maps a Mongoose Vehicle document into the exact shape Flutter's
 * VehicleModel.fromJson() and live_tracking_screen.dart expect.
 *
 * Field aliases are intentionally duplicated so Flutter's multi-key
 * _firstStr / _firstDouble helpers always find at least one match.
 */
function normalise(v) {
  const lat = v.latitude  ?? null;
  const lng = v.longitude ?? null;

  // ── Address resolution (multiple fallbacks match Flutter's _getDisplayAddress) ──
  const address =
    v.address                      ||
    v.lastKnownLocation?.address   ||
    (lat && lng && !(lat === 0 && lng === 0)
      ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
      : 'Unknown location');

  // ── FIX-3: Ignition — emit both key names Flutter probes ─────────────────
  const ignitionBool = v.ignition ?? false;

  // ── FIX-5: Voltage — Flutter probes 'batteryVoltage' and 'voltage' ────────
  const voltageVal = v.voltage ?? 0;

  // ── FIX-8: Today/total distance & engine hours ────────────────────────────
  // todayDistance is the running daily accumulator written by data.processor.js
  // odometer       is the cumulative total written by data.processor.js / device
  const todayKm   = v.todayDistance    ?? 0;
  const totalKm   = v.odometer         ?? 0;
  const engineHrs = v.todayEngineHours ?? 0;

  return {
    // ── Identity ────────────────────────────────────────────────────────────
    id:             (v._id ?? v.id)?.toString(),
    name:           v.name       ?? v.vehicleReg ?? v.imei,
    vehicleReg:     v.vehicleReg ?? '',
    imei:           v.imei       ?? '',

    // ── FIX-7: vehicleTypeKey — Flutter uses this, not 'type' ───────────────
    type:           v.type ?? 'car',
    vehicleTypeKey: v.type ?? 'car',

    protocol:  v.protocol ?? 'WanWay',
    status:    v.status   ?? 'offline',
    isOnline:  v.isOnline ?? false,
    isLive:    v.isLive   ?? false,

    // ── Coordinates — Flutter reads lat/lng AND latitude/longitude ────────
    lat,
    lng,
    latitude:  lat,
    longitude: lng,

    // ── Motion ───────────────────────────────────────────────────────────────
    speed:   v.speed   ?? 0,
    heading: v.heading ?? 0,

    // ── FIX-3: Ignition — both keys ──────────────────────────────────────────
    ignitionOn: ignitionBool,
    ignition:   ignitionBool,

    // ── FIX-5: Battery voltage — both keys ───────────────────────────────────
    batteryVoltage: voltageVal,
    voltage:        voltageVal,

    satellites: v.satellites ?? 0,
    accuracy:   v.accuracy   ?? 0,
    odometer:   totalKm,

    // ── Address — all aliases Flutter probes ─────────────────────────────────
    address,
    location:             address,
    formattedLocation:    address,
    formattedLocationStr: address,
    liveAddress:          address,

    lastKnownLocation: {
      latitude:  lat,
      longitude: lng,
      address,
      timestamp: v.lastUpdate ?? new Date(),
    },

    // ── FIX-10: Timestamps — both keys ───────────────────────────────────────
    lastUpdate:  v.lastUpdate ?? new Date(),
    lastGpsTime: v.lastUpdate ?? new Date(),

    // ── FIX-1 / FIX-4 / FIX-8: Distance & engine hours at top level ─────────
    // Flutter's _seedStates() and _hydrateColdStartData() read these directly
    // from the vehicle model before the mileage report arrives.
    todayDistanceKm:  todayKm,
    totalDistanceKm:  totalKm,
    engineHoursToday: engineHrs,
    maxSpeedToday:    v.todayMaxSpeed ?? 0,

    pocName:    v.pocName    ?? '',
    pocContact: v.pocContact ?? '',
    speedLimit: v.speedLimit ?? 80,

    analytics: v.analytics ?? {},
    userId:    v.userId?.toString() ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles
// ─────────────────────────────────────────────────────────────────────────────
exports.getAllVehicles = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({})
      .select(VEHICLE_FIELDS)
      .limit(1000)
      .lean();

    res.json({ success: true, count: vehicles.length, data: vehicles.map(normalise) });
  } catch (err) {
    logger.error('getAllVehicles error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/live
// ─────────────────────────────────────────────────────────────────────────────
exports.getLiveVehicles = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({})
      .select(VEHICLE_FIELDS)
      .limit(1000)
      .lean();

    res.json({ success: true, count: vehicles.length, data: vehicles.map(normalise) });
  } catch (err) {
    logger.error('getLiveVehicles error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id)
      .select(VEHICLE_FIELDS)
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    res.json({ success: true, data: normalise(vehicle) });
  } catch (err) {
    logger.error('getVehicleById error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/:id/device-info
//
// Flutter calls fetchDeviceInfo(vehicleId).
// FIX-6: Returns ALL install-date field aliases Flutter's _fetchInstallDate()
//        probes in order:
//        activationTime, registrationTime, installDate, install_date,
//        deviceRegistered, firstSeen, created_at, createdAt,
//        addTime, add_time, activateTime, activate_time
// ─────────────────────────────────────────────────────────────────────────────
exports.getDeviceInfo = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id)
      .select('imei vehicleReg name type protocol pocName pocContact createdAt lastUpdate lastKnownLocation')
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    const installDate = vehicle.createdAt ?? new Date();

    res.json({
      success: true,
      data: {
        imei:       vehicle.imei,
        vehicleReg: vehicle.vehicleReg,
        name:       vehicle.name,
        type:       vehicle.type,
        protocol:   vehicle.protocol,
        pocName:    vehicle.pocName,
        pocContact: vehicle.pocContact,

        // FIX-6: Every alias Flutter probes — return the same value for all
        activationTime:  installDate,
        registrationTime: installDate,
        installDate:     installDate,
        install_date:    installDate,
        deviceRegistered: installDate,
        firstSeen:       installDate,
        created_at:      installDate,
        createdAt:       installDate,
        addTime:         installDate,
        add_time:        installDate,
        activateTime:    installDate,
        activate_time:   installDate,

        lastUpdate: vehicle.lastUpdate ?? new Date(),
      },
    });
  } catch (err) {
    logger.error('getDeviceInfo error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/:id/mileage?date=YYYY-MM-DD
//
// Flutter calls fetchMileageReport(vehicleId, date).
// _fetchWanwayDataForVehicle() then probes:
//   - report.todayDistanceKm  (FIX-1: today's driven distance)
//   - report.dailyDistance    (alias)
//   - report.distanceToday    (alias)
//   - report.totalDistanceKm  (FIX-4: cumulative odometer — SEPARATE field)
//   - report.odometer         (alias)
//   - report.odometerKm       (alias)
//   - report.engineHours      (FIX-2: ignition-on hours today)
//   - report.totalEngineHours (alias)
//   - report.runningHours     (alias)
//
// CRITICAL: todayDistanceKm ≠ totalDistanceKm.
//           todayDistanceKm = distance driven today (resets at midnight)
//           totalDistanceKm = cumulative odometer (never resets)
// ─────────────────────────────────────────────────────────────────────────────
exports.getMileageReport = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id)
      .select('imei odometer todayDistance todayEngineHours todayMaxSpeed')
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // ── Date range ────────────────────────────────────────────────────────────
    const dateStr = req.query.date ?? new Date().toISOString().split('T')[0];
    const date    = new Date(dateStr);
    const from    = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(),  0,  0,  0));
    const to      = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59));

    // ── Resolve today distance ────────────────────────────────────────────────
    // Priority 1: DailySummary cache (written by analytics pipeline)
    // Priority 2: analytics.service on-demand computation
    // Priority 3: Vehicle.todayDistance live field (written by data.processor.js)
    // Priority 4: zero — never throw, always return a usable shape

    let todayKm    = 0;
    let totalKm    = vehicle.odometer ?? 0;
    let engineHrs  = 0;
    let runningHrs = 0;
    let idleHrs    = 0;
    let maxSpd     = vehicle.todayMaxSpeed ?? 0;
    let avgSpd     = 0;
    let tripCount  = 0;

    // ── Try DailySummary first ────────────────────────────────────────────────
    let summary = null;
    try {
      summary = await DailySummary.findOne({
        vehicleId: req.params.id,
        date:      from,
      }).lean();
    } catch (summaryErr) {
      logger.warn('DailySummary lookup failed for vehicle %s: %s', req.params.id, summaryErr.message);
    }

    if (summary) {
      // FIX-1: todayDistanceKm is the DAY distance field on DailySummary.
      // If your DailySummary schema stores it as `totalDistance` (meaning
      // distance-for-that-day), map it here. If it has a dedicated
      // `todayDistanceKm` field, use that preferentially.
      todayKm   = summary.todayDistanceKm ?? summary.totalDistance     ?? 0;
      // FIX-4: totalDistanceKm is the ODOMETER — never the day distance.
      totalKm   = summary.totalDistanceKm ?? summary.odometerKm        ?? vehicle.odometer ?? 0;
      // FIX-2: engine hours
      engineHrs  = summary.engineHours    ?? summary.totalEngineHours  ?? 0;
      runningHrs = summary.runningHours   ?? engineHrs;
      idleHrs    = summary.idleHours      ?? 0;
      maxSpd     = summary.maxSpeed       ?? maxSpd;
      avgSpd     = summary.avgSpeed       ?? 0;
      tripCount  = summary.tripCount      ?? 0;

    } else {
      // ── Fallback: analytics.service ─────────────────────────────────────────
      try {
        const { computeDailyFromRaw } = require('../services/analytics.service');
        const stats = await computeDailyFromRaw(
          mongoose.Types.ObjectId(req.params.id),
          from,
          to
        );
        if (stats) {
          todayKm   = stats.todayDistanceKm ?? stats.totalDistance    ?? 0;
          totalKm   = stats.totalDistanceKm ?? stats.odometerKm       ?? vehicle.odometer ?? 0;
          engineHrs  = stats.engineHours    ?? stats.totalEngineHours ?? 0;
          runningHrs = stats.runningHours   ?? engineHrs;
          idleHrs    = stats.idleHours      ?? 0;
          maxSpd     = stats.maxSpeed       ?? maxSpd;
          avgSpd     = stats.avgSpeed       ?? 0;
          tripCount  = stats.tripCount      ?? 0;
        }
      } catch (analyticsErr) {
        logger.warn('analytics.service not available for vehicle %s: %s', req.params.id, analyticsErr.message);
      }

      // ── Final fallback: use vehicle's live running counters ─────────────────
      // data.processor.js keeps todayDistance and todayEngineHours live on
      // the Vehicle document so this is always non-zero during an active day.
      if (todayKm   === 0) todayKm   = vehicle.todayDistance    ?? 0;
      if (engineHrs === 0) engineHrs = vehicle.todayEngineHours ?? 0;
      if (totalKm   === 0) totalKm   = vehicle.odometer         ?? 0;
    }

    // ── Response — every alias Flutter probes ─────────────────────────────────
    res.json({
      success: true,
      data: {
        vehicleId: req.params.id,
        date:      dateStr,

        // FIX-1: Today distance — three aliases Flutter tries in order
        todayDistanceKm: todayKm,
        dailyDistance:   todayKm,
        distanceToday:   todayKm,

        // FIX-4: Odometer (cumulative total) — three aliases, NEVER the same as today
        totalDistanceKm: totalKm,
        odometer:        totalKm,
        odometerKm:      totalKm,

        // FIX-2: Engine hours — three aliases Flutter tries in order
        engineHours:      engineHrs,
        totalEngineHours: engineHrs,
        runningHours:     runningHrs,

        // Additional analytics
        idleHours: idleHrs,
        maxSpeed:  maxSpd,
        avgSpeed:  avgSpd,
        tripCount,
      },
    });
  } catch (err) {
    logger.error('getMileageReport error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehicles
// ─────────────────────────────────────────────────────────────────────────────
exports.createVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.create(req.body);
    res.status(201).json({
      success: true,
      message: 'Vehicle created',
      data:    normalise(vehicle.toObject()),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Vehicle with same IMEI already exists' });
    }
    res.status(400).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/vehicles/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.updateVehicle = async (req, res) => {
  try {
    // Prevent accidental overwrite of live telemetry fields from REST calls
    const {
      latitude, longitude, speed, status,
      isOnline, lastUpdate,
      ...safeBody
    } = req.body;

    const vehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      safeBody,
      { new: true, runValidators: true }
    ).lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    res.json({ success: true, message: 'Vehicle updated', data: normalise(vehicle) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vehicles/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.findByIdAndDelete(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }
    res.json({ success: true, message: 'Vehicle deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehicles/:id/command
//
// Flutter calls sendCommand(vehicleId, commandName).
// Commands: 'Cut Engine', 'Restore Engine', 'Sound Horn',
//           'Reboot Device', 'Request Location', 'Device Settings'
// ─────────────────────────────────────────────────────────────────────────────
exports.sendCommand = async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ success: false, message: 'command is required' });
    }

    const vehicle = await Vehicle.findById(req.params.id)
      .select('imei name vehicleReg')
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    if (global.io) {
      global.io.emit('vehicle_command', {
        vehicleId: req.params.id,
        imei:      vehicle.imei,
        command,
        sentBy:    req.user?._id?.toString(),
        sentAt:    new Date(),
      });
    }

    logger.info('📡 Command [%s] sent to IMEI=%s by user=%s', command, vehicle.imei, req.user?._id);

    res.json({
      success: true,
      message: `Command "${command}" sent to ${vehicle.name || vehicle.imei}`,
    });
  } catch (err) {
    logger.error('sendCommand error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehicles/update-location  (called internally by GPS pipeline)
// ─────────────────────────────────────────────────────────────────────────────
exports.updateLocation = async (req, res) => {
  try {
    const {
      imei, latitude, longitude,
      speed, heading, address,
      ignition, voltage,
    } = req.body;

    const lat = req.body.lat ?? latitude;
    const lng = req.body.lng ?? longitude;

    const vehicle = await Vehicle.findOneAndUpdate(
      { imei },
      {
        latitude:   lat,
        longitude:  lng,
        speed:      speed    ?? 0,
        heading:    heading  ?? 0,
        ignition:   ignition ?? false,
        voltage:    voltage  ?? 0,
        isOnline:   true,
        lastUpdate: new Date(),
        ...(address && { address }),
        lastKnownLocation: {
          latitude:  lat,
          longitude: lng,
          address,
          timestamp: new Date(),
        },
      },
      { new: true, lean: true }
    );

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'IMEI not found' });
    }

    if (global.io) global.io.emit('vehicle_movement', normalise(vehicle));

    res.json({ success: true, data: normalise(vehicle) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/:id/alerts
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleAlerts = async (req, res) => {
  try {
    const alerts = await Alert.find({ vehicleId: req.params.id })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    res.json({ success: true, count: alerts.length, data: alerts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};