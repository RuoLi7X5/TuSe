const mongoose = require('mongoose')

const EventSchema = new mongoose.Schema({
  run_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  ts: { type: Date, default: Date.now },
  phase: { type: String },
  nodes: { type: Number },
  queue: { type: Number },
  solutions: { type: Number },
  perf: { type: Object },
  extra: { type: Object },
}, { timestamps: true })

module.exports = mongoose.model('Event', EventSchema)