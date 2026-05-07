'use strict';

/**
 * utils/distance.js
 * * Geospatial utility functions for distance and noise filtering.
 */

/**
 * Calculates the great-circle distance between two points (WGS-84)
 * using the Haversine formula.
 * * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in Kilometers
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0;

  const R = 6371; // Earth's mean radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Noise Filter / Jitter Guard
 * * Hardware GPS devices often report tiny movements (1-3 meters) 
 * even when the vehicle is stationary due to atmospheric interference.
 * Summing these would lead to "Odometer Creep."
 * * @param {number} distKm - The calculated distance in km
 * @returns {boolean} True if the movement is likely noise
 */
function isNoisePoint(distKm) {
  // Ignore anything less than 5 meters (0.005 km)
  // This prevents the vehicle from "driving" while parked.
  return distKm < 0.005;
}

/**
 * Converts Kilometers to Miles (if needed for UK/US clients)
 */
function kmToMiles(km) {
  return km * 0.621371;
}

/**
 * Converts Meters per Second to Kilometers per Hour
 */
function mpsToKmph(mps) {
  return mps * 3.6;
}

module.exports = {
  haversineKm,
  isNoisePoint,
  kmToMiles,
  mpsToKmph
};