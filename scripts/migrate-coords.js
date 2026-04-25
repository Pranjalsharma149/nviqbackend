'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const mongoose = require('mongoose');

const OPTS = {
  maxPoolSize: 100, minPoolSize: 10,
  serverSelectionTimeoutMS: 30000, socketTimeoutMS: 60000,
  heartbeatFrequencyMS: 10000, family: 4, autoIndex: false, retryWrites: true,
};

const Vehicle      = mongoose.model('Vehicle',      new mongoose.Schema({}, { strict: false }), 'vehicles');
const LocationPing = mongoose.model('LocationPing', new mongoose.Schema({}, { strict: false }), 'locationpings');

function gcj02ToWgs84(gcjLng, gcjLat) {
  const a = 6378245.0, ee = 0.00669342162296594323;
  function tLat(lng, lat) {
    let r = -100+2*lng+3*lat+0.2*lat*lat+0.1*lng*lat+0.2*Math.sqrt(Math.abs(lng));
    r+=(20*Math.sin(6*lng*Math.PI)+20*Math.sin(2*lng*Math.PI))*2/3;
    r+=(20*Math.sin(lat*Math.PI)+40*Math.sin(lat/3*Math.PI))*2/3;
    r+=(160*Math.sin(lat/12*Math.PI)+320*Math.sin(lat*Math.PI/30))*2/3;
    return r;
  }
  function tLng(lng, lat) {
    let r=300+lng+2*lat+0.1*lng*lng+0.1*lng*lat+0.1*Math.sqrt(Math.abs(lng));
    r+=(20*Math.sin(6*lng*Math.PI)+20*Math.sin(2*lng*Math.PI))*2/3;
    r+=(20*Math.sin(lng*Math.PI)+40*Math.sin(lng/3*Math.PI))*2/3;
    r+=(150*Math.sin(lng/12*Math.PI)+300*Math.sin(lng/30*Math.PI))*2/3;
    return r;
  }
  const dLat=tLat(gcjLng-105,gcjLat-35), dLng=tLng(gcjLng-105,gcjLat-35);
  const radLat=gcjLat/180*Math.PI;
  let magic=Math.sin(radLat); magic=1-ee*magic*magic;
  const sq=Math.sqrt(magic);
  return {
    lat: gcjLat-(dLat*180)/((a*(1-ee))/(magic*sq)*Math.PI),
    lng: gcjLng-(dLng*180)/(a/sq*Math.cos(radLat)*Math.PI)
  };
}

function isValid(lat, lng) {
  return lat!=null && lng!=null && !isNaN(+lat) && !isNaN(+lng) &&
         !(+lat===0 && +lng===0) && !(+lat===28.6139 && +lng===77.2090);
}

async function migrateVehicles() {
  console.log('\n📦 Migrating Vehicle collection...');
  const vehicles = await Vehicle.find({}).lean();
  console.log('   Found ' + vehicles.length + ' vehicles');
  const ops = [];
  for (const v of vehicles) {
    const u = {};
    if (isValid(v.latitude, v.longitude)) {
      const {lat,lng} = gcj02ToWgs84(+v.longitude, +v.latitude);
      u.latitude=lat; u.longitude=lng;
      console.log('   ' + (v.imei||v._id) + ': (' + (+v.latitude).toFixed(6) + ',' + (+v.longitude).toFixed(6) + ') -> (' + lat.toFixed(6) + ',' + lng.toFixed(6) + ')');
    }
    const lkl = v.lastKnownLocation;
    if (lkl && isValid(lkl.latitude, lkl.longitude)) {
      const {lat,lng} = gcj02ToWgs84(+lkl.longitude, +lkl.latitude);
      u['lastKnownLocation.latitude']=lat; u['lastKnownLocation.longitude']=lng;
    }
    if (Object.keys(u).length) ops.push({updateOne:{filter:{_id:v._id},update:{$set:u}}});
  }
  if (ops.length) { const r=await Vehicle.bulkWrite(ops,{ordered:false}); console.log('   ✅ Updated ' + r.modifiedCount + ' vehicles'); }
  else console.log('   ℹ️  Nothing to update');
}

async function migrateLocationPings() {
  console.log('\n📦 Migrating LocationPing collection...');
  const total = await LocationPing.countDocuments();
  console.log('   Found ' + total + ' pings');
  if (!total) { console.log('   ℹ️  Nothing to migrate'); return; }
  let skip=0, updated=0;
  while (skip < total) {
    const pings = await LocationPing.find({}).skip(skip).limit(500).lean();
    const ops = [];
    for (const p of pings) {
      if (!isValid(p.latitude,p.longitude)) continue;
      const {lat,lng} = gcj02ToWgs84(+p.longitude,+p.latitude);
      ops.push({updateOne:{filter:{_id:p._id},update:{$set:{latitude:lat,longitude:lng}}}});
    }
    if (ops.length) { const r=await LocationPing.bulkWrite(ops,{ordered:false}); updated+=r.modifiedCount; }
    skip+=500;
    process.stdout.write('\r   Progress: ' + Math.round(Math.min(skip,total)/total*100) + '% (' + Math.min(skip,total) + '/' + total + ')   ');
  }
  console.log('\n   ✅ Updated ' + updated + ' pings');
}

async function main() {
  console.log('🚀 GCJ-02 -> WGS-84 Migration\n');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('❌ MONGO_URI missing from .env'); process.exit(1); }
  console.log('⏳ Connecting...');
  await mongoose.connect(uri, OPTS);
  console.log('✅ Connected -> ' + mongoose.connection.host + '/' + mongoose.connection.name);
  await migrateVehicles();
  await migrateLocationPings();
  console.log('\n🎉 Done! All coords now WGS-84.\n');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('❌ Failed:', e.message); process.exit(1); });
