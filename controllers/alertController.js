const Alert = require('../models/Alert');

/**
 * @desc    Get all alerts for the fleet
 * @route   GET /api/alerts
 * @access  Private (or Public based on SKIP_AUTH)
 */
exports.getAlerts = async (req, res) => {
  try {
    // We populate 'vehicle' to get the name and plate instead of just an ID
    const alerts = await Alert.find()
      .populate('vehicle', 'name plateNumber')
      .sort({ createdAt: -1 });

    res.status(200).json(alerts);
  } catch (error) {
    console.error("❌ Get Alerts Error:", error.message);
    res.status(500).json({ 
      success: false, 
      message: "Server Error: Could not fetch alerts",
      error: error.message 
    });
  }
};

/**
 * @desc    Mark a specific alert as read
 * @route   PUT /api/alerts/:id
 * @access  Private
 */
exports.markAsRead = async (req, res) => {
  try {
    const alert = await Alert.findById(req.params.id);

    if (!alert) {
      return res.status(404).json({ 
        success: false, 
        message: 'Alert not found' 
      });
    }

    alert.isRead = true;
    await alert.save();

    res.status(200).json({ 
      success: true, 
      message: 'Alert marked as read',
      data: alert 
    });
  } catch (error) {
    console.error("❌ Mark Alert Error:", error.message);
    res.status(500).json({ 
      success: false, 
      message: "Server Error: Could not update alert",
      error: error.message 
    });
  }
};

/**
 * @desc    Delete an alert (Optional but useful for cleanup)
 * @route   DELETE /api/alerts/:id
 */
exports.deleteAlert = async (req, res) => {
  try {
    const alert = await Alert.findByIdAndDelete(req.params.id);
    if (!alert) {
      return res.status(404).json({ message: "Alert not found" });
    }
    res.status(200).json({ message: "Alert deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};