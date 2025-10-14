const mongoose = require('mongoose')

const GraphSchema = new mongoose.Schema({
  graph_signature: { type: String, required: true, index: true, unique: true },
  image_hash: { type: String },
  palette_size: { type: Number },
  n_triangles: { type: Number },
  n_components: { type: Number },
  bridge_density: { type: Number },
  dispersion_avg: { type: Number },
  boundary_len: { type: Number },
  color_entropy: { type: Number },
  features: { type: Object },
  features_vector: { type: [Number] },
  updated_at: { type: Date, default: Date.now },
}, { timestamps: true })

module.exports = mongoose.model('Graph', GraphSchema)