const mongoose = require('mongoose')

const UCBSchema = new mongoose.Schema({
  graph_signature: { type: String, required: true, unique: true, index: true },
  counts_json: { type: Object },
  rewards_json: { type: Object },
  total_pulls: { type: Number },
}, { timestamps: true })

module.exports = mongoose.model('UCB', UCBSchema)