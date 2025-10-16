const mongoose = require('mongoose')

const StrategySchema = new mongoose.Schema({
  graph_signature: { type: String, required: true, unique: true, index: true },
  strategy_json: { type: Object },
}, { timestamps: true })

module.exports = mongoose.model('Strategy', StrategySchema)