const mongoose = require('mongoose')

const CacheSchema = new mongoose.Schema({
  graph_signature: { type: String, required: true, index: true, unique: true },
  path: { type: [String] },
  min_steps: { type: Number },
  start_id: { type: Number },
  flags_json: { type: Object },
}, { timestamps: true })

module.exports = mongoose.model('Cache', CacheSchema)