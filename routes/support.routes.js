'use strict';

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth');
const Ticket = require('../models/Ticket');

const SLA = {
  Critical: '15 minutes',
  High:     '1 hour',
  Medium:   '4 hours',
  Low:      '24 hours',
};

function generateTicketId() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `TKT-${ts}-${rand}`;
}

router.post('/ticket', async (req, res) => {
  try {
    const {
      issueCategory = 'Other',
      priority      = 'Medium',
      vehicleId,
      description,
      userName      = 'App User',
      userPhone,
      userEmail,
    } = req.body;

    if (!description || description.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Description is required (min 5 characters)' });
    }

    const ticketId = generateTicketId();

    await Ticket.create({
      ticketId,
      issueCategory: issueCategory.trim(),
      priority,
      vehicleId:     vehicleId?.trim(),
      description:   description.trim(),
      userName:      userName?.trim() || 'App User',
      userPhone:     userPhone?.trim(),
      userEmail:     userEmail?.trim(),
    });

    res.status(201).json({
      success:      true,
      ticketId,
      slaResponse:  SLA[priority] || SLA.Medium,
      whatsappSent: false,
      emailSent:    false,
      message:      'Ticket submitted successfully',
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/tickets', protect, async (req, res) => {
  try {
    const tickets = await Ticket.find({}).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, count: tickets.length, data: tickets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/ticket/:ticketId/resolve', protect, async (req, res) => {
  try {
    await Ticket.findOneAndUpdate({ ticketId: req.params.ticketId }, { $set: { status: 'resolved' } });
    res.json({ success: true, message: 'Ticket resolved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
