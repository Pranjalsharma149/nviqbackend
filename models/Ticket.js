'use strict';
const mongoose = require('mongoose');
const ticketSchema = new mongoose.Schema({
  ticketId:      { type: String, unique: true },
  issueCategory: { type: String, default: 'Other' },
  priority:      { type: String, default: 'Medium' },
  vehicleId:     { type: String },
  description:   { type: String, required: true },
  userName:      { type: String, default: 'App User' },
  userPhone:     { type: String },
  userEmail:     { type: String },
  status:        { type: String, default: 'open' },
  createdAt:     { type: Date, default: Date.now },
});
module.exports = mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema, 'tickets');
