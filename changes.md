# NVIQ Fleet API & Integration Documentation (Flutter/Android Team)

This document details recent backend fixes, the unified logic for vehicle tracking/history metrics, and complete API specifications for the live tracking and history endpoints.

---

## 🛠️ Summary of Recent Fixes

### 1. Unified Running Time Logic
* **The Issue**: Live tracking returned `"0h 38m"` (`0.633h`) while history returned `"0h 35m"` for the same day. 
* **The Cause**: The live tracking controller de-duplicated overlapping trips (starts within 60s of each other) by merging their durations (`Math.max`), whereas the history controller compared their distance and discarded the smaller one completely.
* **The Fix**: Both APIs now share the identical robust de-duplication algorithm. Overlapping trips starting within 60 seconds are merged by taking the maximum duration, distance, and speed, and the latest end time.

### 2. Stops Count Self-Healing & Live Calculation
* **The Issue**: Stop counts for live tracking were static or drifted out of sync with history.
* **The Fix**: The `/api/tracking/live` endpoint dynamically recalculates today's stop counts using raw GPS logs (detecting moving-to-stopped transitions) and performs self-healing database writes if the vehicle document cache differs.

### 3. Address Resolution & Storage
* **The Issue**: Address values in live tracking sometimes defaulted to `null` or were overwritten during batch ingestion updates.
* **The Fix**: Geocoding runs synchronously during ingestion before saving. The batch update route uses MongoDB dot-notation (`$set: { 'lastKnownLocation.address': ... }`) to prevent overwriting existing nested address fields. Live status mapping has been updated to query from aliases like `address`, `location`, `liveAddress`, and `lastKnownLocation.address` to prevent any field-mapping errors on the mobile client.

---

## 📡 Complete API Specifications

### 1. Live Tracking status
* **Endpoint**: `GET /api/tracking/live`
* **Access**: Protected (Requires User JWT in `Authorization: Bearer <token>`)
* **Description**: Returns the real-time status of all active vehicles, populated with today's distance, stops, running time, online status, battery voltage, and geocoded addresses.

#### Request Headers
```http
Authorization: Bearer <your-jwt-token>
```

#### Response Example (`200 OK`)
```json
{
  "success": true,
  "count": 1,
  "data": [
    {
      "id": "6a07b1ee4775686d33966bf2",
      "vehicleId": "6a07b1ee4775686d33966bf2",
      "name": "Vehicle Tracker 1",
      "vehicleReg": "DL1AA1234",
      "type": "truck",
      "vehicleTypeKey": "truck",
      "imei": "356218606576971",
      "protocol": "wanway",
      "lat": 27.386698,
      "lng": 76.66211,
      "latitude": 27.386698,
      "longitude": 76.66211,
      "speed": 0,
      "heading": 0,
      "status": "offline",
      "todayStops": 8,
      "ignition": false,
      "ignitionOn": false,
      "acc": false,
      "ignitionSince": "2026-05-31T04:45:00.000Z",
      "statusSince": "2026-05-31T05:05:00.000Z",
      "batteryVoltage": 12.9,
      "voltage": 12.9,
      "battery": 12.9,
      "satellites": 12,
      "accuracy": 1,
      "isOnline": false,
      "isLive": false,
      "liveAddress": "Alwar, Rajasthan, India",
      "lastKnownLocation": {
        "latitude": 27.386698,
        "longitude": 76.66211,
        "lat": 27.386698,
        "long": 76.66211,
        "speed": 0,
        "heading": 0,
        "voltage": 12.9,
        "odometer": 12345.6,
        "address": "Alwar, Rajasthan, India",
        "locationName": "Alwar, Rajasthan, India",
        "timestamp": "2026-05-31T17:30:36.000Z"
      },
      "lastUpdate": "2026-05-31T17:30:36.000Z",
      "lastGpsTime": "2026-05-31T17:30:36.000Z",
      "lastOnlineAt": "2026-05-31T17:30:36.000Z",
      "offlineDuration": "2h 30m",
      "parkingDuration": "2h 30m",
      "parkingSeconds": 9000,
      "parkingSince": "2026-05-31T05:05:00.000Z",
      "todayDistanceKm": 4.00,
      "todayDistance": 4.00,
      "totalDistanceKm": 4.00,
      "odometer": 12345.6,
      "engineHoursToday": 0.83,
      "todayEngineHours": 0.83,
      "todayRunningHours": 0.6333333333333333,
      "runningHoursToday": 0.6333333333333333,
      "runningHours": 0.6333333333333333,
      "running_time": "0h 38m",
      "runningTime": "0h 38m",
      "todayMaxSpeed": 65,
      "pocName": "John Doe",
      "pocContact": "9876543210",
      "speedLimit": 80,
      "analytics": {},
      "timestamp": "2026-05-31T17:30:36.000Z"
    }
  ]
}
```

---

### 2. Vehicle History Statistics & Trips
* **Endpoint**: `GET /api/history/vehicle/:vehicleId`
* **Access**: Protected (Requires User JWT in `Authorization: Bearer <token>`)
* **Description**: Returns aggregated metrics (distance, running time, max speed, total stops) and detailed trips list for a specific vehicle over a predefined or custom period in Indian Standard Time (IST).

#### Query Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `period` | String | No | Period options: `day`, `week`, `month`. Defaults to `week` (last 7 days). |
| `date` | String | No | Date in `YYYY-MM-DD` format (only applicable when `period=day`). Defaults to today. |
| `startDate`| String | No | Custom start date in `YYYY-MM-DD` format (ignored if `period` is set). |
| `endDate` | String | No | Custom end date in `YYYY-MM-DD` format (ignored if `period` is set). |

#### Period Options Quick Reference

1. **Today / Specific Day**
   * Path: `/api/history/vehicle/6a07b1ee4775686d33966bf2?period=day`
   * Path (Specific Day): `/api/history/vehicle/6a07b1ee4775686d33966bf2?period=day&date=2026-05-31`
2. **Last 7 Days (Week)**
   * Path: `/api/history/vehicle/6a07b1ee4775686d33966bf2?period=week` (or omit parameters entirely)
3. **Last 30 Days (Month)**
   * Path: `/api/history/vehicle/6a07b1ee4775686d33966bf2?period=month`
4. **Custom Date Range**
   * Path: `/api/history/vehicle/6a07b1ee4775686d33966bf2?startDate=2026-05-01&endDate=2026-05-15`

#### Response Example (`200 OK`)
```json
{
  "success": true,
  "vehicleId": "6a07b1ee4775686d33966bf2",
  "vehicleName": "Vehicle Tracker 1",
  "period": "day",
  "dateRange": {
    "start": "2026-05-31",
    "end": "2026-05-31"
  },
  "data": {
    "distance": "4.00 km",
    "running_time": "0h 38m",
    "max_speed": "65.0 km/h",
    "totalstops": 8,
    "trips": [
      {
        "date": "2026-05-31",
        "startTime": "10:22 AM",
        "endTime": "10:30 AM",
        "tripStart": "Alwar, Rajasthan, India",
        "tripEnd": "Industrial Area, Alwar, India",
        "duration": "8 mins",
        "distance": "0.64 km",
        "max_speed": "42.0 km/h",
        "avg_speed": "15.0 km/h",
        "stops": 1,
        "latlong": {
          "lat": "27.38669",
          "long": "76.66211"
        }
      },
      {
        "date": "2026-05-31",
        "startTime": "10:31 AM",
        "endTime": "10:37 AM",
        "tripStart": "Industrial Area, Alwar, India",
        "tripEnd": "Noida Sector 62, UP, India",
        "duration": "6 mins",
        "distance": "0.97 km",
        "max_speed": "55.0 km/h",
        "avg_speed": "22.0 km/h",
        "stops": 0,
        "latlong": {
          "lat": "27.39121",
          "long": "76.67134"
        }
      }
    ]
  }
}
```

---

## 📡 Live Socket Updates
For real-time map plotting, listen to the socket events `vehicle_movement` and `vehicleMovement` broadcast on connection:
```javascript
socket.on('vehicle_movement', (data) => {
  // Contains same attributes as a single item in the live tracking response array:
  // data.latitude, data.longitude, data.speed, data.running_time, data.todayStops, etc.
});
```

---

## 🚀 Recommended Action Items for Frontend (Flutter/Android)

1. **Field Binding Consistency**:
   * For **running time**, bind to `running_time` (formatted string `"0h 38m"`) or `todayRunningHours` / `runningHoursToday` (raw hours float `0.6333...`) consistently.
   * For **current location/address**, map to `liveAddress` or `lastKnownLocation.address`.
2. **API Alignment**:
   * Keep history queries aligned to the `period` query parameter choices. Avoid parsing custom ranges on the client-side; let the backend handle UTC boundaries.
