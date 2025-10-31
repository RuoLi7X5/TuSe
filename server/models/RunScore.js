const mongoose = require('mongoose')

const RunScoreSchema = new mongoose.Schema({
  graph_signature: { type: String, required: true, index: true },
  run_id: { type: mongoose.Schema.Types.ObjectId, index: true, unique: true, sparse: true },
  algo_name: { type: String },
  min_steps: { type: Number },
  best_start_id: { type: Number },
  time_ms: { type: Number },
  is_unified: { type: Boolean, default: true },
  quality: { type: String, enum: ['final','approx'], default: 'final' },
  source: { type: String, enum: ['auto_solve','continue_shortest','optimize_path','cache'], default: 'auto_solve' },
  flags_json: { type: Object },
  // 新增：模块评分所需字段
  path_len: { type: Number },
  algo_scores: [{ key: { type: String }, score: { type: Number }, metrics: { type: Object } }],
}, { timestamps: true })

module.exports = mongoose.model('RunScore', RunScoreSchema)