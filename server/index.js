require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')

const app = express()
app.use(cors({ origin: [/^http:\/\/localhost:\d+$/], credentials: false }))
app.use(express.json({ limit: '2mb' }))

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/zhezhituse'
const PORT = process.env.PORT || 3001

// Models
const Graph = require('./models/Graph')
const Run = require('./models/Run')
const Event = require('./models/Event')
const Recommendation = require('./models/Recommendation')
const Cache = require('./models/Cache')

// Health
app.get('/api/health', (req, res)=>{ res.json({ ok: true }) })

// Start run
app.post('/api/runs/start', async (req, res)=>{
  try {
    const { graph_signature, features, flags } = req.body || {}
    if (!graph_signature) return res.status(400).json({ error: 'graph_signature required' })
    const f = features||{}
    const vec = [f.palette_size, f.n_triangles, f.n_components, f.bridge_density, f.dispersion_avg, f.boundary_len, f.color_entropy]
    await Graph.updateOne(
      { graph_signature },
      { $set: { graph_signature, features: f, palette_size: f.palette_size, n_triangles: f.n_triangles, n_components: f.n_components, bridge_density: f.bridge_density, dispersion_avg: f.dispersion_avg, boundary_len: f.boundary_len, color_entropy: f.color_entropy, features_vector: vec, updated_at: new Date() } },
      { upsert: true }
    )
    const run = await Run.create({ graph_signature, flags, status: 'running', started_at: new Date() })
    res.json({ run_id: run._id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Log event
app.post('/api/events', async (req, res)=>{
  try {
    const { run_id, phase, nodes, queue, solutions, perf, extra } = req.body || {}
    if (!run_id) return res.status(400).json({ error: 'run_id required' })
    await Event.create({ run_id, phase, nodes, queue, solutions, perf, extra, ts: new Date() })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Finish run
app.post('/api/runs/finish', async (req, res)=>{
  try {
    const { run_id, status, min_steps, best_start_id } = req.body || {}
    if (!run_id) return res.status(400).json({ error: 'run_id required' })
    await Run.updateOne({ _id: run_id }, { $set: { status: status||'finished', min_steps, best_start_id, finished_at: new Date() } })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Recommendations (simple stub based on history)
app.get('/api/recommend/params', async (req, res)=>{
  try {
    const { signature } = req.query
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const g = await Graph.findOne({ graph_signature: signature })
    const last = await Run.findOne({ graph_signature: signature, status: 'finished', min_steps: { $exists: true } }).sort({ finished_at: -1 })
    const recDoc = await Recommendation.findOne({ graph_signature: signature })
    // 规则版覆盖：基于图特征简单启发式
    const f = g?.features || {}
    const rules = {}
    if ((f.bridge_density||0) > 0.25 || (f.n_components||0) > 10) { rules.enableBridgeFirst = true; rules.bifrontWeight = 2 }
    if ((f.n_components||0) > 14) { rules.enableBeam = true; rules.beamWidth = 48 }
    if ((f.palette_size||0) <= 3) { rules.useDFSFirst = false; rules.enableBestFirst = true }
    if ((f.color_entropy||0) > 2.0) { rules.minDeltaRatio = 0.015 }
    // KNN 相似检索：在图表中按特征向量的欧氏距离选近邻
    let knnStartId = null; let lbEstimate = null
    if (g?.features_vector && g.features_vector.length>=3) {
      const baseVec = g.features_vector
      const others = await Graph.find({ graph_signature: { $ne: signature }, features_vector: { $exists: true } }).limit(200)
      const scored = []
      for(const og of others){
        const v = og.features_vector || []
        if (!v || v.length !== baseVec.length) continue
        let d=0; for(let i=0;i<v.length;i++){ const a=Number(baseVec[i]||0), b=Number(v[i]||0); const diff=a-b; d += diff*diff }
        scored.push({ sig: og.graph_signature, dist: Math.sqrt(d) })
      }
      scored.sort((a,b)=>a.dist-b.dist)
      const top = scored.slice(0,5)
      const neighborRuns = await Run.find({ graph_signature: { $in: top.map(t=>t.sig) }, status: 'finished', min_steps: { $exists: true } }).sort({ finished_at: -1 })
      if (neighborRuns && neighborRuns.length>0) {
        knnStartId = neighborRuns[0]?.best_start_id ?? null
        const mins = neighborRuns.map(r=>r.min_steps).filter(x=>typeof x==='number')
        if (mins.length>0) lbEstimate = Math.round(mins.reduce((a,b)=>a+b,0)/mins.length)
      }
    }
    res.json({
      start_id: recDoc?.recommended_start_id ?? last?.best_start_id ?? knnStartId ?? null,
      flags_overrides: { ...(recDoc?.recommended_flags_json||{}), ...rules },
      lb_estimate: recDoc?.lb_estimate ?? lbEstimate ?? null,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Similar graphs (naive: same palette/components)
app.get('/api/similar', async (req, res)=>{
  try {
    const { signature } = req.query
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const g = await Graph.findOne({ graph_signature: signature })
    if (!g) return res.json({ neighbors: [] })
    const neighbors = await Graph.find({
      palette_size: g.palette_size,
      n_components: g.n_components,
    }).limit(10)
    res.json({ neighbors: neighbors.map(x=>x.graph_signature) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Cache lookup
app.get('/api/cache/path', async (req, res)=>{
  try {
    const { signature } = req.query
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const c = await Cache.findOne({ graph_signature: signature })
    if (!c) return res.json(null)
    res.json({ path: c.path, min_steps: c.min_steps, start_id: c.start_id, flags: c.flags_json })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Cache write
app.post('/api/cache/path', async (req, res)=>{
  try {
    const { graph_signature, path, min_steps, start_id, flags } = req.body || {}
    if (!graph_signature) return res.status(400).json({ error: 'graph_signature required' })
    await Cache.updateOne(
      { graph_signature },
      { $set: { graph_signature, path: path||[], min_steps, start_id, flags_json: flags||{} } },
      { upsert: true }
    )
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

mongoose.connect(MONGODB_URI).then(()=>{
  app.listen(PORT, ()=>{ console.log(`[server] listening on http://localhost:${PORT}, db=${MONGODB_URI}`) })
}).catch(err=>{
  console.error('[server] mongo connect error:', err)
  process.exit(1)
})