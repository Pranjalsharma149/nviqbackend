// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/fleet/trends (7-Day Activity Chart)
// ─────────────────────────────────────────────────────────────────────────────
exports.getFleetTrends = async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Aggregate trip data into daily buckets for chart visualization
    const trends = await Trip.aggregate([
      { $match: { startTime: { $gte: startDate }, isCompleted: true } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$startTime" } },
          distance: { $sum: "$totalDistance" },
          trips: { $sum: 1 }
        }
      },
      { $sort: { "_id": 1 } } // Order by date ascending
    ]);

    res.json({
      success: true,
      data: trends.map(t => ({
        date: t._id,
        totalKm: t.distance.toFixed(1),
        tripCount: t.trips
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};