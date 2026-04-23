'use strict';

/**
 * REGISTERED_DEVICES
 * Single Source of Truth for fleet configuration.
 * * Scalability Note: While this array works great for hundreds of devices,
 * for 20k+ devices, you will eventually want to move this registry
 * entirely into a MongoDB collection with an Index on IMEI.
 */
const REGISTERED_DEVICES = [
  {
    imei:         '356218606576971',   // Primary Key — Vehicle Tracker 1 (PT06)
    vehicleReg:   'HR26AB1234',
    name:         'Vehicle Tracker 1',
    type:         'car',               // Used for Flutter map icons
    protocol:     'PT06',              // ← Updated from GT06 to PT06 (confirmed from IOP GPS portal)
    pocName:      'John Doe',
    pocContact:   '+919999999999',
    speedLimit:   80,                  // Engine triggers alert > 80 km/h
    fuelAlert:    15,                  // Alert when fuel < 15%
    battAlert:    20,                  // Alert when battery < 20%
  },
  // Add more devices below...
];

// ── OPTIMIZED LOOKUPS ────────────────────────────────────────────────────────
// Using Maps ensures O(1) lookup time even as the list grows to thousands.
const BY_IMEI = new Map();
const BY_REG  = new Map();

// Initialize maps once at startup
REGISTERED_DEVICES.forEach(device => {
  if (device.imei)       BY_IMEI.set(String(device.imei), device);
  if (device.vehicleReg) BY_REG.set(String(device.vehicleReg), device);
});

module.exports = {
  REGISTERED_DEVICES,

  /**
   * getByIMEI
   * Used by GPS TCP server to identify incoming packets
   */
  getByIMEI: (imei) => {
    if (!imei) return null;
    return BY_IMEI.get(String(imei)) || null;
  },

  /**
   * getByReg
   * Used by API to find vehicle by plate number
   */
  getByReg: (reg) => {
    if (!reg) return null;
    return BY_REG.get(String(reg)) || null;
  },

  /**
   * isKnownDevice
   * Quick boolean check to drop unauthorized traffic early
   */
  isKnownDevice: (imei) => BY_IMEI.has(String(imei)),

  getAllIMEIs: () => Array.from(BY_IMEI.keys()),
};

/**
 * 💡 OPERATIONAL NOTES (PT06)
 * ─────────────────────────────────────────────────────────────────────────────
 * To configure the physical PT06 tracker, send SMS commands to the SIM number
 * inside the device (9876543210):
 *
 * 1. SET SERVER IP & PORT:
 *    SMS: "SERVER,0,[YOUR_PUBLIC_IP],5001,0#"
 *    Example: "SERVER,0,171.61.17.205,5001,0#"
 *
 * 2. SET APN (use your SIM provider's APN):
 *    SMS: "APN,[APN_NAME]#"
 *    Example for Jio: "APN,jionet#"
 *    Example for Airtel: "APN,airtelgprs.com#"
 *
 * 3. SET REPORTING INTERVAL:
 *    SMS: "TIMER,10,60#"  (10s when moving, 60s when stationary)
 *
 * 4. SET TIMEZONE TO UTC:
 *    SMS: "GMT,E,0,0#"
 *
 * 5. CHECK STATUS:
 *    SMS: "STATUS#"  — device replies with current config
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT: Your server must be publicly accessible on port 5001.
 * If running locally, use a tool like ngrok:
 *   ngrok tcp 5001
 * Then use the ngrok IP/port in the SERVER SMS command above.
 * ─────────────────────────────────────────────────────────────────────────────
 */