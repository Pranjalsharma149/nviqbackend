'use strict';

const axios = require('axios');
const logger = require('./logger');

// In-memory cache to avoid duplicate requests for the same coordinates
const geocodeCache = new Map();

/**
 * Custom override for specific coordinate ranges if needed
 */
function getManualAddressOverride(lat, lng) {
  if (lat >= 20.37 && lat <= 20.38 && lng >= 72.92 && lng <= 72.93) {
    return 'Krishna Society, Vapi, Valsad District, Gujarat, India';
  }
  return null;
}

/**
 * Reverse geocodes coordinates to a human-readable address.
 * Uses Google Geocoding API if GOOGLE_GEOCODING_KEY is set,
 * otherwise falls back to OpenStreetMap Nominatim.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string>}
 */
async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    return 'Unknown Location';
  }

  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (geocodeCache.has(key)) {
    return geocodeCache.get(key);
  }

  try {
    const manualAddr = getManualAddressOverride(lat, lng);
    if (manualAddr) {
      geocodeCache.set(key, manualAddr);
      return manualAddr;
    }

    // Try Google Maps Geocoding if key is present
    if (process.env.GOOGLE_GEOCODING_KEY) {
      try {
        const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
          params: {
            latlng: `${lat},${lng}`,
            key: process.env.GOOGLE_GEOCODING_KEY,
            language: 'en',
            region: 'in',
          },
          timeout: 5000,
        });
        const addr = res.data?.results?.[0]?.formatted_address ?? null;
        if (addr) {
          geocodeCache.set(key, addr);
          return addr;
        }
      } catch (err) {
        logger.debug('⚠️ [addressFetch] Google Maps reverse geocode failed, trying Nominatim: %s', err.message);
      }
    }

    // Fallback: OpenStreetMap Nominatim
    const res = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon: lng, format: 'json', zoom: 18 },
      headers: { 'User-Agent': 'NVIQFleetServer/1.0' },
      timeout: 5000,
    });
    const addr = res.data?.display_name ?? null;
    if (addr) {
      geocodeCache.set(key, addr);
      return addr;
    }

    const coordStr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    geocodeCache.set(key, coordStr);
    return coordStr;
  } catch (err) {
    logger.warn('⚠️ [addressFetch] Geocoding error: %s', err.message);
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

/**
 * Resolves address for a latitude and longitude.
 * 1. Checks LocationPing for recently resolved address for the vehicle.
 * 2. Falls back to reverseGeocode.
 * 3. Updates Vehicle's address & lastKnownLocation.address if coordinates match current location.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string|ObjectId} vehicleId
 * @returns {Promise<string>}
 */
async function getAddressForCoords(lat, lng, vehicleId = null) {
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    return 'Unknown Location';
  }

  // 1. Try to find recently resolved address in LocationPing for this vehicle
  if (vehicleId) {
    const LocationPing = require('../models/LocationPing');
    const latTolerance = 0.0005; // ~50m
    const lngTolerance = 0.0005;
    
    try {
      const matchedPing = await LocationPing.findOne({
        vehicleId: vehicleId.toString(),
        latitude: { $gte: lat - latTolerance, $lte: lat + latTolerance },
        longitude: { $gte: lng - lngTolerance, $lte: lng + lngTolerance },
        address: { $ne: null, $ne: '' }
      }).sort({ gpsTime: -1 }).lean();

      if (matchedPing && matchedPing.address) {
        return matchedPing.address;
      }
    } catch (e) {
      logger.debug('⚠️ [addressFetch] LocationPing search failed: %s', e.message);
    }
  }

  // 2. Call external geocoding service
  const address = await reverseGeocode(lat, lng);

  // 3. Update Vehicle's lastKnownLocation and address in DB if it represents the current location
  if (vehicleId && address && address !== 'Unknown Location') {
    const Vehicle = require('../models/Vehicle');
    try {
      const vehicle = await Vehicle.findById(vehicleId).select('latitude longitude lastKnownLocation').lean();
      if (vehicle) {
        const currentLat = vehicle.latitude ?? vehicle.lastKnownLocation?.latitude ?? 0;
        const currentLng = vehicle.longitude ?? vehicle.lastKnownLocation?.longitude ?? 0;
        
        const latDiff = Math.abs(currentLat - lat);
        const lngDiff = Math.abs(currentLng - lng);
        
        // If coordinate difference is very small, sync the address fields
        if (latDiff < 0.0005 && lngDiff < 0.0005) {
          await Vehicle.findByIdAndUpdate(vehicleId, {
            $set: {
              address: address,
              'lastKnownLocation.address': address
            }
          });
        }
      }
    } catch (e) {
      logger.warn('⚠️ [addressFetch] Syncing address to Vehicle document failed: %s', e.message);
    }
  }

  return address;
}

module.exports = {
  reverseGeocode,
  getAddressForCoords
};
