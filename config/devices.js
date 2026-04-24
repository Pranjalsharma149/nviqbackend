'use strict';

/**
 * REGISTERED_DEVICES
 * Single Source of Truth for fleet configuration.
 *
 * Protocols:
 *   PT06      → connects via IOP GPS (WanWay platform) — polled every 30s
 *   GT06      → connects directly via TCP port 5001
 *
 * Scalability Note: For 20k+ devices, move this registry into MongoDB
 * with an index on IMEI.
 */
const REGISTERED_DEVICES = [

  // ── IOP GPS Platform Devices (WanWay) ──────────────────────────────────────
  {
    imei:         '356218606576971',
    vehicleReg:   'HR26AB1234',
    name:         'Vehicle Tracker 1',
    type:         'car',
    protocol:     'PT06',              // Via IOP GPS platform
    pocName:      'John Doe',
    pocContact:   '+919999999999',
    speedLimit:   80,
    fuelAlert:    15,
    battAlert:    20,
  },
  {
    imei:         '868720064616620',
    vehicleReg:   'DEVICE2',           // ← Replace with real plate number
    name:         'Vehicle Tracker 2',
    type:         'car',               // ← Update if truck/bike
    protocol:     'PT06',              // Via IOP GPS platform
    pocName:      '',
    pocContact:   '',
    speedLimit:   80,
    fuelAlert:    15,
    battAlert:    20,
    sim:          '89911025034030798906',
  },

  // ── Direct TCP Devices (GT06 protocol → port 5001) ─────────────────────────
  {
    imei:         '866221070653410',
    vehicleReg:   'DEVICE3',           // ← Replace with real plate number
    name:         'Vehicle Tracker 3',
    type:         'car',               // ← Update if truck/bike
    protocol:     'GT06',              // Direct TCP — PRIME09
    pocName:      '',
    pocContact:   '',
    speedLimit:   80,
    fuelAlert:    15,
    battAlert:    20,
  },
  {
    imei:         '867010072155188',
    vehicleReg:   'DEVICE4',           // ← Replace with real plate number
    name:         'Vehicle Tracker 4',
    type:         'car',               // ← Update if truck/bike
    protocol:     'GT06',              // Direct TCP — VL149
    pocName:      '',
    pocContact:   '',
    speedLimit:   80,
    fuelAlert:    15,
    battAlert:    20,
  },

];

// ── OPTIMIZED LOOKUPS ─────────────────────────────────────────────────────────
const BY_IMEI = new Map();
const BY_REG  = new Map();

REGISTERED_DEVICES.forEach(device => {
  if (device.imei)       BY_IMEI.set(String(device.imei), device);
  if (device.vehicleReg) BY_REG.set(String(device.vehicleReg), device);
});

module.exports = {
  REGISTERED_DEVICES,

  getByIMEI:     (imei) => BY_IMEI.get(String(imei)) || null,
  getByReg:      (reg)  => BY_REG.get(String(reg))   || null,
  isKnownDevice: (imei) => BY_IMEI.has(String(imei)),
  getAllIMEIs:   ()      => Array.from(BY_IMEI.keys()),

  // Returns only IMEIs that use the IOP GPS platform (polled via WanWay)
  getIopIMEIs: () => REGISTERED_DEVICES
    .filter(d => d.protocol === 'PT06')
    .map(d => d.imei),

  // Returns only IMEIs that connect directly via TCP
  getTcpIMEIs: () => REGISTERED_DEVICES
    .filter(d => d.protocol === 'GT06')
    .map(d => d.imei),
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DEVICE SUMMARY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Device 1 — PT06      | IMEI: 356218606576971 | Via WanWay IOP GPS
 * Device 2 — PT06 lite | IMEI: 868720064616620 | Via WanWay IOP GPS
 * Device 3 — PRIME09   | IMEI: 866221070653410 | Direct TCP port 5001
 * Device 4 — VL149     | IMEI: 867010072155188 | Direct TCP port 5001
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONFIGURING DIRECT TCP DEVICES (PRIME09 & VL149)
 * Send these SMS commands to each device's SIM card number:
 *
 * 1. SET SERVER:   SERVER,0,[YOUR_SERVER_IP],5001,0#
 * 2. SET APN:      APN,airtelgprs.com#
 * 3. SET INTERVAL: TIMER,10,60#
 * 4. SET TIMEZONE: GMT,E,0,0#
 * 5. CHECK STATUS: STATUS#
 *
 * ⚠️  IMPORTANT: Render.com does NOT support TCP port 5001.
 *     For direct TCP devices you need a VPS (DigitalOcean/AWS)
 *     with port 5001 open, OR register them on WanWay platform instead.
 * ─────────────────────────────────────────────────────────────────────────────
 */