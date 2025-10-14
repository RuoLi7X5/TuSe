const mongoose = require('mongoose')

const RecommendationSchema = new mongoose.Schema({
  graph_signature: { type: String, required: true, index: true, unique: true },
  recommended_start_id: { type: Number },
  recommended_flags_json: { type: Object },
  lb_estimate: { type: Number },
}, { timestamps: true })

module.exports = mongoose.model('Recommendation', RecommendationSchema)