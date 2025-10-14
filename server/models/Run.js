const mongoose = require('mongoose')

const RunSchema = new mongoose.Schema({
  graph_signature: { type: String, required: true, index: true },
  flags: { type: Object },
  status: { type: String, enum: ['running','finished','error'], default: 'running' },
  min_steps: { type: Number },
  best_start_id: { type: Number },
  started_at: { type: Date },
  finished_at: { type: Date },
}, { timestamps: true })

module.exports = mongoose.model('Run', RunSchema)