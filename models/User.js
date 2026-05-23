'use strict';

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const userSchema = new mongoose.Schema({
  name:      { type: String, required: [true, 'Name is required'], trim: true, maxlength: 80 },
  firstName: { type: String, trim: true, maxlength: 50 },
  lastName:  { type: String, trim: true, maxlength: 50 },
  email:     { type: String, unique: true, sparse: true, lowercase: true, trim: true, match: [/^\S+@\S+\.\S+$/, 'Invalid email'] },
  password:  { type: String, minlength: 6, select: false },
  phone:     { type: String, trim: true, sparse: true },
  role:      { type: String, enum: ['admin', 'fleet_manager', 'dispatcher', 'operations', 'owner', 'driver', 'supervisor'], default: 'fleet_manager' },

  company:      { type: String, trim: true, maxlength: 100 },
  fleetSize:    { type: String, trim: true },
  vehicleTypes: [{ type: String, trim: true }],
  fleetId:      { type: String, trim: true, sparse: true, index: true },
  logo:         { type: String, trim: true },

  onboardingStep:     { type: Number, default: 0 },
  onboardingComplete: { type: Boolean, default: false },

  status:   { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active', index: true },

  plan:     { type: String, default: 'Free Plan' },
  location: { type: String, trim: true },
  avatar:   { type: String },
  fcmToken: { type: String },

  resetPasswordToken:  { type: String, select: false },
  resetPasswordExpire: { type: Date,   select: false },

  // ── Referral system ──────────────────────────────────────────────────────
  referralCode:    { type: String, unique: true, sparse: true },
  referredBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  referralApplied: { type: Boolean, default: false },
  credits:         { type: Number, default: 0 },

  lastLogin: { type: Date },
}, {
  timestamps: true,
  versionKey: false,
});

// ── Password Hashing ─────────────────────────────────────────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── Methods ──────────────────────────────────────────────────────────────────
userSchema.methods.matchPassword = async function (entered) {
  return bcrypt.compare(entered, this.password);
};

userSchema.methods.getSignedJwtToken = function () {
  return jwt.sign(
    { id: this._id, role: this.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '180d' }
  );
};

userSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.password;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpire;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);