// config/devices.js
//
// ══════════════════════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH FOR ALL GPS DEVICES
// ══════════════════════════════════════════════════════════════════════════════
//
// HOW TO ADD A NEW DEVICE (5 seconds):
//   1. Get IMEI from device label or SMS *#06# to device SIM
//   2. Add entry below in REGISTERED_DEVICES array
//   3. Restart server — vehicle auto-creates in MongoDB
//   4. Configure device via SMS (see bottom of file)
//
// HOW IT WORKS:
//   PT06 device powers on → connects TCP to YOUR_IP:5001
//   → Sends IMEI in login packet
//   → Server looks up IMEI here → finds vehicle config
//   → Auto-creates Vehicle in MongoDB if new
//   → Device sends GPS every 10s → server emits to Flutter via Socket.IO
//   → Your car marker moves on map in real time
//
'use strict';

const REGISTERED_DEVICES = [

  // ══════════════════════════════════════════════════════════════════════════
  // YOUR REAL PT06 DEVICE
  // ══════════════════════════════════════════════════════════════════════════
  {
    imei:        '356218606576971',   // ← your actual device IMEI
    vehicleReg:  'UP80AB1234',        // ← change to your actual plate number
    name:        'My Car (PT06)',     // ← change to your car name
    type:        'car',               // car | truck | bike | auto | bus | van | ambulance | tractor
    protocol:    'GT06',              // PT06 uses GT06 binary protocol
    pocName:     'Driver Name',       // ← change to actual driver
    pocContact:  '+919999999999',     // ← change to actual contact
    speedLimit:  80,                  // km/h — alert fires above this
    fuelAlert:   15,                  // % — alert fires below this
    battAlert:   20,                  // % — alert fires below this
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ADD MORE DEVICES HERE — one block per device
  // Works for 2G / 3G / 4G variants — all use same GT06 binary protocol
  // ══════════════════════════════════════════════════════════════════════════

  // {
  //   imei:       '123456789012345',
  //   vehicleReg: 'DL1AB2345',
  //   name:       'Truck 1',
  //   type:       'truck',
  //   protocol:   'GT06',
  //   pocName:    'Ramesh Kumar',
  //   pocContact: '+919876543210',
  //   speedLimit: 60,
  // },

  // {
  //   imei:       '987654321098765',
  //   vehicleReg: 'MH02CD5678',
  //   name:       'Bike 1',
  //   type:       'bike',
  //   protocol:   'GT06',
  //   pocName:    'Suresh Pal',
  //   pocContact: '+918765432109',
  //   speedLimit: 50,
  // },

];

// ── Fast lookup maps (built at startup, O(1) reads) ───────────────────────────
const BY_IMEI = new Map(REGISTERED_DEVICES.map(d => [d.imei, d]));
const BY_REG  = new Map(REGISTERED_DEVICES.map(d => [d.vehicleReg, d]));

module.exports = {
  REGISTERED_DEVICES,
  getByIMEI:   imei => BY_IMEI.get(imei) || null,
  getByReg:    reg  => BY_REG.get(reg)   || null,
  getAllIMEIs:  ()   => REGISTERED_DEVICES.map(d => d.imei),
};

// ══════════════════════════════════════════════════════════════════════════════
// PT06 DEVICE CONFIGURATION (send these SMS to device SIM)
// ══════════════════════════════════════════════════════════════════════════════
//
// Step 1 — Set your server IP and port:
//   IP[YOUR_SERVER_PUBLIC_IP],5001#
//   Example: IP123.456.78.90,5001#
//
// Step 2 — Set mobile data APN (ask your SIM carrier):
//   APNNAME[carrier_apn]#
//   Airtel:  APNNAME airtelgprs.com#
//   Jio:     APNNAME jionet#
//   BSNL:    APNNAME bsnlnet#
//   Vodafone:APNNAME www#
//
// Step 3 — Set GPS update interval (10 seconds):
//   TIMER10#
//
// Step 4 — Check device status:
//   STATUS#
//   (Device replies with IP, signal, GPS status)
//