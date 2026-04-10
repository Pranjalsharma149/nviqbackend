const mongoose = require('mongoose');

const ticketSchema = mongoose.Schema({
  vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // The reporter
  title: { type: String, required: true },
  description: { type: String },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  status: { type: String, enum: ['open', 'in-progress', 'resolved', 'closed'], default: 'open' },
  category: { type: String, enum: ['maintenance', 'accident', 'fuel', 'other'] }
}, { timestamps: true });

module.exports = mongoose.model('Ticket', ticketSchema);