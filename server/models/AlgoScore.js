const mongoose = require('mongoose')

const AlgoScoreSchema = new mongoose.Schema({
  algo_name: { type: String, required: true, index: true },
  graph_signature: { type: String, required: true, index: true },
  total_runs: { type: Number, default: 0 },
  final_unified_runs: { type: Number, default: 0 },
  avg_min_steps: { type: Number, default: 0 },
  avg_time_ms: { type: Number, default: 0 },
  // 新增：模块评分聚合字段
  algorithm_key: { type: String, index: true },
  runs_count: { type: Number, default: 0 },
  success_count: { type: Number, default: 0 },
  total_score: { type: Number, default: 0 },
  avg_score: { type: Number, default: 0 },
  metrics_total: { type: Object, default: {} },
}, { timestamps: true })

module.exports = mongoose.model('AlgoScore', AlgoScoreSchema)