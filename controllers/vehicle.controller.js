'use strict';

/**
 * controllers/vehicle.controller.js
 *
 * REST API controller for all vehicle-related endpoints.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY FIXES (this version):
 *
 *   FIX-SCOPE-1  getAllVehicles() and getLiveVehicles() previously called
 *                Vehicle.find({}) with NO filter — every user saw every vehicle
 *                in the database. Now filters by req.user.phone so each user
 *                only receives their own vehicles.
 *
 *   FIX-SCOPE-2  createVehicle() previously trusted the phone/userId from the
 *                request body — a client could claim any phone. Now phone and
 *                userId are always taken from req.user (set by protect middleware)
 *                and the 16-vehicle limit is enforced here too.
 *
 *   FIX-SCOPE-3  getVehicleById() previously had no ownership check — any
 *                authenticated user could fetch any vehicle by ID. Now verifies
 *                vehicle.phone === req.user.phone before responding.
 *
 *   FIX-SCOPE-4  getVehicleAlerts() previously returned alerts for any vehicleId
 *                without checking ownership. Now verifies ownership first.
 *
 *   FIX-SCOPE-5  updateVehicle() and deleteVehicle() previously had no ownership
 *                check. Now verifies vehicle.phone === req.user.phone.
 *
 *   FIX-SCOPE-6  sendCommand() now verifies vehicle ownership before emitting
 *                socket command.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PREVIOUSLY APPLIED FIXES (unchanged):
 *
 *   FIX-1  getMileageReport: returns todayDistanceKm, dailyDistance, distanceToday
 *          as SEPARATE fields from totalDistanceKm (odometer).
 *
 *   FIX-2  getMileageReport: returns engineHours, totalEngineHours, runningHours
 *          so Flutter _fetchWanwayDataForVehicle() finds the field regardless of
 *          which alias it tries first.
 *
 *   FIX-3  normalise(): emits ignitionOn AND ignition so Flutter's _parseBoolField
 *          catches it on both keys.
 *
 *   FIX-4  getMileageReport: totalDistanceKm / odometer / odometerKm taken from
 *          the ODOMETER field, never conflated with today's distance.
 *
 *   FIX-5  normalise(): batteryVoltage AND voltage both emitted.
 *
 *   FIX-6  getDeviceInfo: returns all install-date aliases Flutter probes.
 *
 *   FIX-7  normalise(): vehicleTypeKey added.
 *
 *   FIX-8  normalise(): todayDistanceKm, totalDistanceKm, engineHoursToday
 *          exposed at top level.
 *
 *   FIX-9  getMileageReport: falls back gracefully when DailySummary and
 *          analytics.service are both unavailable.
 *
 *   FIX-10 normalise(): lastGpsTime added as alias for lastUpdate.
 */

const mongoose     = require('mongoose');
const Vehicle      = require('../models/Vehicle');
const DailySummary = require('../models/DailySummary');
const RawGpsLog    = require('../models/RawGpsLog');
const Alert        = require('../models/Alert');
const logger       = require('../utils/logger');

// ── Field selector ─────────────────────────────────────────────────────────────
const VEHICLE_FIELDS = [
  'name', 'vehicleReg', 'registrationNumber', 'imei', 'type', 'protocol',
  'status', 'deviceStatus', 'isOnline', 'isLive', 'gpsSignal',
  'latitude', 'longitude', 'speed', 'heading',
  'ignition', 'voltage', 'satellites', 'accuracy', 'odometer',
  'address', 'location', 'lastUpdate', 'lastKnownLocation',
  'todayDistance', 'todayEngineHours', 'todayMaxSpeed',
  'pocName', 'pocContact', 'speedLimit',
  'analytics', 'userId', 'phone',
  'createdAt', 'updatedAt',
].join(' ');

// ── Ownership helper ───────────────────────────────────────────────────────────
/**
 * Returns the vehicle if it exists AND belongs to the requesting user.
 * Returns null if not found, throws nothing — callers handle the response.
 */
async function findOwnedVehicle(vehicleId, userPhone, fields = 'phone') {
  const vehicle = await Vehicle.findById(vehicleId).select(fields).lean();
  if (!vehicle) return { vehicle: null, reason: 'not_found' };
  if (vehicle.phone !== userPhone) return { vehicle: null, reason: 'forbidden' };
  return { vehicle, reason: null };
}

// ── Normalise → Flutter VehicleModel fields ────────────────────────────────────
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

  // ── Address resolution ───────────────────────────────────────────────────────
  const address =
    v.address                    ||
    v.lastKnownLocation?.address ||
    (lat && lng && !(lat === 0 && lng === 0)
      ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
      : 'Unknown location');

  // ── FIX-3: Ignition — both key names Flutter probes ─────────────────────────
  const ignitionBool = v.ignition ?? false;

  // ── FIX-5: Voltage — Flutter probes 'batteryVoltage' and 'voltage' ──────────
  const voltageVal = v.voltage ?? 0;

  // ── FIX-8: Today / total distance & engine hours ─────────────────────────────
  const todayKm   = v.todayDistance    ?? 0;
  const totalKm   = v.odometer         ?? 0;
  const engineHrs = v.todayEngineHours ?? 0;

  // vehicleReg — schema uses registrationNumber, some docs use vehicleReg
  const reg = v.vehicleReg ?? v.registrationNumber ?? '';

  return {
    // ── Identity ─────────────────────────────────────────────────────────────
    id:             (v._id ?? v.id)?.toString(),
    name:           v.name       ?? reg ?? v.imei ?? 'Vehicle',
    vehicleReg:     reg,
    imei:           v.imei       ?? '',

    // ── FIX-7: vehicleTypeKey — Flutter uses this, not just 'type' ───────────
    type:           v.type ?? 'car',
    vehicleTypeKey: v.type ?? 'car',

    protocol:  v.protocol ?? 'GT06',
    status:    v.status   ?? 'offline',
    isOnline:  v.isOnline ?? false,
    isLive:    v.isLive   ?? false,
    gpsSignal: v.gpsSignal ?? true,

    // ── Coordinates — Flutter reads lat/lng AND latitude/longitude ───────────
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

    // ── FIX-1 / FIX-4 / FIX-8: Distance & engine hours at top level ──────────
    todayDistanceKm:  todayKm,
    totalDistanceKm:  totalKm,
    engineHoursToday: engineHrs,
    maxSpeedToday:    v.todayMaxSpeed ?? 0,

    pocName:    v.pocName    ?? '',
    pocContact: v.pocContact ?? '',
    speedLimit: v.speedLimit ?? 80,

    analytics: v.analytics ?? {},
    userId:    v.userId?.toString() ?? null,

    // ownerId — Flutter fleet_provider.dart FIX-22 reads this field to filter
    // socket broadcasts. We expose the phone as ownerId so the Flutter-side
    // guard  (ownerId !== _currentNviqId) works correctly.
    ownerId: v.phone ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles
//
// FIX-SCOPE-1: Was Vehicle.find({}) — returned ALL vehicles to every user.
// Now filters by req.user.phone so each user only sees their own fleet.
// ─────────────────────────────────────────────────────────────────────────────
exports.getAllVehicles = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const vehicles = await Vehicle.find({ phone })
      .select(VEHICLE_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count:   vehicles.length,
      data:    vehicles.map(normalise),
    });
  } catch (err) {
    logger.error('getAllVehicles error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/live
//
// FIX-SCOPE-1: Same fix as getAllVehicles — was returning every device in DB.
// Flutter calls this endpoint on dashboard load via ApiService.fetchLiveVehicles().
// ─────────────────────────────────────────────────────────────────────────────
exports.getLiveVehicles = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const vehicles = await Vehicle.find({ phone })
      .select(VEHICLE_FIELDS)
      .sort({ lastUpdate: -1 })
      .lean();

    res.json({
      success: true,
      count:   vehicles.length,
      data:    vehicles.map(normalise),
    });
  } catch (err) {
    logger.error('getLiveVehicles error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/:id
//
// FIX-SCOPE-3: Was returning any vehicle by ID with no ownership check.
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleById = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const vehicle = await Vehicle.findById(req.params.id)
      .select(VEHICLE_FIELDS)
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // FIX-SCOPE-3: ownership check
    if (vehicle.phone !== phone) {
      return res.status(403).json({ success: false, message: 'Not authorized to access this vehicle' });
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
// FIX-SCOPE-3: Added ownership check.
// FIX-6: Returns ALL install-date aliases Flutter's _fetchInstallDate() probes.
// ─────────────────────────────────────────────────────────────────────────────
exports.getDeviceInfo = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const vehicle = await Vehicle.findById(req.params.id)
      .select('imei vehicleReg registrationNumber name type protocol pocName pocContact createdAt lastUpdate lastKnownLocation phone')
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // FIX-SCOPE-3: ownership check
    if (vehicle.phone !== phone) {
      return res.status(403).json({ success: false, message: 'Not authorized to access this vehicle' });
    }

    const installDate = vehicle.createdAt ?? new Date();
    const reg         = vehicle.vehicleReg ?? vehicle.registrationNumber ?? '';

    res.json({
      success: true,
      data: {
        imei:       vehicle.imei,
        vehicleReg: reg,
        name:       vehicle.name,
        type:       vehicle.type,
        protocol:   vehicle.protocol,
        pocName:    vehicle.pocName,
        pocContact: vehicle.pocContact,

        // FIX-6: every alias Flutter probes in _fetchInstallDate()
        activationTime:   installDate,
        registrationTime: installDate,
        installDate:      installDate,
        install_date:     installDate,
        deviceRegistered: installDate,
        firstSeen:        installDate,
        created_at:       installDate,
        createdAt:        installDate,
        addTime:          installDate,
        add_time:         installDate,
        activateTime:     installDate,
        activate_time:    installDate,

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
// FIX-SCOPE-3: Added ownership check.
// FIX-1/2/4/9: Today distance, engine hours, odometer all correctly separated.
// ─────────────────────────────────────────────────────────────────────────────
exports.getMileageReport = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const vehicle = await Vehicle.findById(req.params.id)
      .select('imei odometer todayDistance todayEngineHours todayMaxSpeed phone')
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // FIX-SCOPE-3: ownership check
    if (vehicle.phone !== phone) {
      return res.status(403).json({ success: false, message: 'Not authorized to access this vehicle' });
    }

    // ── Date range ─────────────────────────────────────────────────────────────
    const dateStr = req.query.date ?? new Date().toISOString().split('T')[0];
    const date    = new Date(dateStr);
    const from    = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(),  0,  0,  0));
    const to      = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59));

    let todayKm    = 0;
    let totalKm    = vehicle.odometer      ?? 0;
    let engineHrs  = 0;
    let runningHrs = 0;
    let idleHrs    = 0;
    let maxSpd     = vehicle.todayMaxSpeed ?? 0;
    let avgSpd     = 0;
    let tripCount  = 0;

    // ── Priority 1: DailySummary cache ────────────────────────────────────────
    let summary = null;
    try {
      summary = await DailySummary.findOne({
        vehicleId: req.params.id,
        date:      from,
      }).lean();
    } catch (summaryErr) {
      logger.warn('DailySummary lookup failed for %s: %s', req.params.id, summaryErr.message);
    }

    if (summary) {
      // FIX-1: day distance — separate from cumulative odometer
      todayKm   = summary.todayDistanceKm  ?? summary.totalDistance     ?? 0;
      // FIX-4: odometer — never the same as today distance
      totalKm   = summary.totalDistanceKm  ?? summary.odometerKm        ?? vehicle.odometer ?? 0;
      // FIX-2: engine hours
      engineHrs  = summary.engineHours     ?? summary.totalEngineHours  ?? 0;
      runningHrs = summary.runningHours    ?? engineHrs;
      idleHrs    = summary.idleHours       ?? 0;
      maxSpd     = summary.maxSpeed        ?? maxSpd;
      avgSpd     = summary.avgSpeed        ?? 0;
      tripCount  = summary.tripCount       ?? 0;

    } else {
      // ── Priority 2: analytics.service on-demand computation ─────────────────
      try {
        const { computeDailyFromRaw } = require('../services/analytics.service');
        const stats = await computeDailyFromRaw(
          mongoose.Types.ObjectId(req.params.id),
          from,
          to
        );
        if (stats) {
          todayKm    = stats.todayDistanceKm  ?? stats.totalDistance    ?? 0;
          totalKm    = stats.totalDistanceKm  ?? stats.odometerKm       ?? vehicle.odometer ?? 0;
          engineHrs  = stats.engineHours      ?? stats.totalEngineHours ?? 0;
          runningHrs = stats.runningHours     ?? engineHrs;
          idleHrs    = stats.idleHours        ?? 0;
          maxSpd     = stats.maxSpeed         ?? maxSpd;
          avgSpd     = stats.avgSpeed         ?? 0;
          tripCount  = stats.tripCount        ?? 0;
        }
      } catch (analyticsErr) {
        logger.warn('analytics.service unavailable for %s: %s', req.params.id, analyticsErr.message);
      }

      // ── Priority 3: vehicle live counters (data.processor.js keeps these live)
      if (todayKm   === 0) todayKm   = vehicle.todayDistance    ?? 0;
      if (engineHrs === 0) engineHrs = vehicle.todayEngineHours ?? 0;
      if (totalKm   === 0) totalKm   = vehicle.odometer         ?? 0;
    }

    // ── Response — every alias Flutter probes ──────────────────────────────────
    res.json({
      success: true,
      data: {
        vehicleId: req.params.id,
        date:      dateStr,

        // FIX-1: today distance — three aliases Flutter tries
        todayDistanceKm: todayKm,
        dailyDistance:   todayKm,
        distanceToday:   todayKm,

        // FIX-4: odometer (cumulative) — never the same value as today distance
        totalDistanceKm: totalKm,
        odometer:        totalKm,
        odometerKm:      totalKm,

        // FIX-2: engine hours — three aliases Flutter tries
        engineHours:      engineHrs,
        totalEngineHours: engineHrs,
        runningHours:     runningHrs,

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
//
// FIX-SCOPE-2: phone and userId now always come from req.user (auth token),
// never from the request body. Client cannot spoof ownership.
// Also enforces the 16-vehicle limit (was only in routes/vehicles.js before).
// ─────────────────────────────────────────────────────────────────────────────
exports.createVehicle = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    // Enforce 16-vehicle limit
    const count = await Vehicle.countDocuments({ phone });
    if (count >= 16) {
      return res.status(400).json({
        success:  false,
        message:  'Cannot register more than 16 vehicles per account',
      });
    }

    // Strip phone/userId from body — must come from auth only
    const { phone: _p, userId: _u, ...safeBody } = req.body;

    const vehicle = await Vehicle.create({
      ...safeBody,
      phone,              // FIX-SCOPE-2: always from auth token
      userId: req.user._id,
    });

    res.status(201).json({
      success: true,
      message: 'Vehicle created',
      data:    normalise(vehicle.toObject()),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle with same registration number already exists',
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/vehicles/:id
//
// FIX-SCOPE-5: Added ownership check before allowing update.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateVehicle = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const vehicle = await Vehicle.findById(req.params.id).lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // FIX-SCOPE-5: ownership check
    if (vehicle.phone !== phone) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this vehicle' });
    }

    // Prevent accidental overwrite of live telemetry fields from REST calls
    const {
      latitude, longitude, speed,
      isOnline, lastUpdate,
      phone: _p, userId: _u,   // also strip auth fields
      ...safeBody
    } = req.body;

    const updated = await Vehicle.findByIdAndUpdate(
      req.params.id,
      safeBody,
      { new: true, runValidators: true }
    ).lean();

    res.json({ success: true, message: 'Vehicle updated', data: normalise(updated) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vehicles/:id
//
// FIX-SCOPE-5: Added ownership check before allowing delete.
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteVehicle = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const vehicle = await Vehicle.findById(req.params.id).select('phone name').lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // FIX-SCOPE-5: ownership check
    if (vehicle.phone !== phone) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this vehicle' });
    }

    await Vehicle.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: 'Vehicle deleted' });
  } catch (err) {
    logger.error('deleteVehicle error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehicles/:id/command
//
// FIX-SCOPE-6: Added ownership check before emitting socket command.
// ─────────────────────────────────────────────────────────────────────────────
exports.sendCommand = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ success: false, message: 'command is required' });
    }

    const vehicle = await Vehicle.findById(req.params.id)
      .select('imei name vehicleReg registrationNumber phone')
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // FIX-SCOPE-6: ownership check
    if (vehicle.phone !== phone) {
      return res.status(403).json({ success: false, message: 'Not authorized to command this vehicle' });
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

    const reg = vehicle.vehicleReg ?? vehicle.registrationNumber ?? vehicle.imei;
    logger.info('📡 Command [%s] sent to IMEI=%s by user phone=%s', command, vehicle.imei, phone);

    res.json({
      success: true,
      message: `Command "${command}" sent to ${vehicle.name || reg}`,
    });
  } catch (err) {
    logger.error('sendCommand error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehicles/update-location  (called internally by GPS pipeline)
//
// This endpoint is called by the GPS data processor, NOT by the Flutter app.
// It is intentionally NOT user-scoped — the GPS device authenticates via IMEI,
// not via a user phone. Keep the protect middleware OFF this route in routes file.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateLocation = async (req, res) => {
  try {
    const {
      imei, latitude, longitude,
      speed, heading, address,
      ignition, voltage, satellites, accuracy,
    } = req.body;

    if (!imei) {
      return res.status(400).json({ success: false, message: 'imei is required' });
    }

    const lat = req.body.lat ?? latitude;
    const lng = req.body.lng ?? longitude;

    const vehicle = await Vehicle.findOneAndUpdate(
      { imei },
      {
        latitude:   lat,
        longitude:  lng,
        speed:      speed      ?? 0,
        heading:    heading    ?? 0,
        ignition:   ignition   ?? false,
        voltage:    voltage    ?? 0,
        satellites: satellites ?? 0,
        accuracy:   accuracy   ?? 0,
        isOnline:   true,
        isLive:     true,
        lastUpdate: new Date(),
        ...(address && { address }),
        lastKnownLocation: {
          latitude:  lat,
          longitude: lng,
          address:   address ?? null,
          timestamp: new Date(),
        },
      },
      { new: true, lean: true }
    );

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'IMEI not registered' });
    }

    const normalised = normalise(vehicle);

    // Emit to all connected Flutter clients — Flutter's socket guard (FIX-I)
    // uses ownerId to filter out vehicles that don't belong to the current user.
    if (global.io) global.io.emit('vehicle_movement', normalised);

    res.json({ success: true, data: normalised });
  } catch (err) {
    logger.error('updateLocation error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/:id/alerts
//
// FIX-SCOPE-4: Added ownership check before returning alerts.
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleAlerts = async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    // FIX-SCOPE-4: verify vehicle belongs to this user before returning its alerts
    const vehicle = await Vehicle.findById(req.params.id).select('phone').lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    if (vehicle.phone !== phone) {
      return res.status(403).json({ success: false, message: 'Not authorized to access alerts for this vehicle' });
    }

    const alerts = await Alert.find({ vehicleId: req.params.id })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    res.json({ success: true, count: alerts.length, data: alerts });
  } catch (err) {
    logger.error('getVehicleAlerts error: %s', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};