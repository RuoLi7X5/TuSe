const mongoose = require('mongoose')

const CacheSchema = new mongoose.Schema({
  graph_signature: { type: String, required: true, index: true, unique: true },
  // 支持 legacy steps（String[]）与 action steps（{startId,color}[]）
  path: { type: [mongoose.Schema.Types.Mixed] },
  min_steps: { type: Number },
  start_id: { type: Number },
  flags_json: { type: Object },
  // 题目数据（用于离线补传/后端校验/回放）；可选
  puzzle_json: { type: mongoose.Schema.Types.Mixed },
  // 标记是否为统一颜色的正解
  is_unified: { type: Boolean, default: true },
  // 质量标记：final（正解）、approx（接近解）
  quality: { type: String, enum: ['final','approx'], default: 'final' },
}, { timestamps: true })

module.exports = mongoose.model('Cache', CacheSchema)