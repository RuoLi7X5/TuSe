require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const path = require('path')
const crypto = require('crypto')
const tokens = new Set()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ruoli'
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/zhezhituse'
const PORT = process.env.PORT || 3001

const app = express()
app.use(cors({ origin: [/^http:\/\/localhost:\d+$/], credentials: false }))
app.use(express.json({ limit: '2mb' }))

function authMiddleware(req, res, next){
  try {
    const auth = req.headers.authorization || ''
    const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null
    const queryToken = (req.query && req.query.token) ? String(req.query.token) : null
    const token = headerToken || queryToken
    if (!token || !tokens.has(token)) return res.status(401).json({ error: 'unauthorized' })
    next()
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' })
  }
}

// Models
const Graph = require('./models/Graph')
const Run = require('./models/Run')
const Event = require('./models/Event')
const Recommendation = require('./models/Recommendation')
const Cache = require('./models/Cache')
const UCB = require('./models/UCB')
const Strategy = require('./models/Strategy')
const RunScore = require('./models/RunScore')
const AlgoScore = require('./models/AlgoScore')

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
    // 推送到订阅者（SSE）
    try { broadcastEvent(run_id, { run_id, phase, nodes, queue, solutions, perf, extra, ts: new Date().toISOString() }) } catch {}
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

// Graph list for admin dashboard
app.get('/api/graphs/list', async (req, res)=>{
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query?.limit||'50'), 10) || 50))
    const docs = await Graph.find({}).sort({ updated_at: -1 }).limit(limit)
    // Optional: mark if strategy exists
    const sigs = docs.map(d=>d.graph_signature)
    const strategies = await Strategy.find({ graph_signature: { $in: sigs } }, { graph_signature: 1 }).lean()
    const strategySet = new Set(strategies.map(s=>s.graph_signature))
    res.json(docs.map(d=>({
      graph_signature: d.graph_signature,
      updated_at: d.updated_at,
      palette_size: d.palette_size,
      n_triangles: d.n_triangles,
      n_components: d.n_components,
      bridge_density: d.bridge_density,
      dispersion_avg: d.dispersion_avg,
      boundary_len: d.boundary_len,
      color_entropy: d.color_entropy,
      has_strategy: strategySet.has(d.graph_signature),
    })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Helper: suspicious path detection (approx mistakenly marked as final)
function isPathSuspicious(path){
  try {
    if (!Array.isArray(path) || path.length===0) return true
    const invalid = new Set(['', 'transparent', null, undefined])
    let prev = null
    for (const c of path) {
      if (invalid.has(c)) return true
      if (prev!==null && c===prev) return true
      prev = c
    }
    return false
  } catch { return true }
}
// Cache lookup
app.get('/api/cache/path', async (req, res)=>{
  try {
    const { signature, only_final } = req.query
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const c = await Cache.findOne({ graph_signature: signature })
    if (!c) return res.json(null)
    // 可选：仅返回正解；同时过滤可疑路径（连续同色或非法颜色）
    if (String(only_final||'').toLowerCase()==='true'){
      if (!(c.is_unified===true && c.quality==='final')) return res.json(null)
      if (isPathSuspicious(c.path)) return res.json(null)
    }
    res.json({ path: c.path, min_steps: c.min_steps, start_id: c.start_id, flags: c.flags_json, is_unified: c.is_unified===true, quality: c.quality||'final' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Cache write
app.post('/api/cache/path', async (req, res)=>{
  try {
    const { graph_signature, path, min_steps, start_id, flags, is_unified, quality } = req.body || {}
    if (!graph_signature) return res.status(400).json({ error: 'graph_signature required' })
    // 默认质量：根据 is_unified 推断，并对可疑路径降级为 approx
    const suspicious = isPathSuspicious(path)
    const q = quality || ((is_unified===false || suspicious) ? 'approx' : 'final')
    const unified = (is_unified!==false) && !suspicious
    await Cache.updateOne(
      { graph_signature },
      { $set: { graph_signature, path: path||[], min_steps, start_id, flags_json: flags||{}, is_unified: unified, quality: q } },
      { upsert: true }
    )
    res.json({ ok: true, downgraded: suspicious })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// UCB stats: aggregate per graph signature
app.get('/api/learn/ucb', async (req, res)=>{
  try {
    const { signature } = req.query || {}
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const doc = await UCB.findOne({ graph_signature: signature })
    if (!doc) return res.json(null)
    res.json({ counts: doc.counts_json || {}, rewards: doc.rewards_json || {}, totalPulls: doc.total_pulls || 0 })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/learn/ucb', async (req, res)=>{
  try {
    const { graph_signature, counts, rewards, totalPulls } = req.body || {}
    if (!graph_signature) return res.status(400).json({ error: 'graph_signature required' })
    const prev = await UCB.findOne({ graph_signature })
    const prevCounts = prev?.counts_json || {}
    const prevRewards = prev?.rewards_json || {}
    const nextCounts = { ...prevCounts }
    const nextRewards = { ...prevRewards }
    if (counts && typeof counts === 'object') {
      for (const [c, n] of Object.entries(counts)) {
        nextCounts[c] = (Number(nextCounts[c])||0) + (Number(n)||0)
      }
    }
    if (rewards && typeof rewards === 'object') {
      for (const [c, r] of Object.entries(rewards)) {
        nextRewards[c] = (Number(nextRewards[c])||0) + (Number(r)||0)
      }
    }
    const mergedTotal = (Number(prev?.total_pulls)||0) + (Number(totalPulls)||0)
    await UCB.updateOne(
      { graph_signature },
      { $set: { graph_signature, counts_json: nextCounts, rewards_json: nextRewards, total_pulls: mergedTotal } },
      { upsert: true }
    )
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Run scoring: record result and update algo aggregation
app.post('/api/score/run', async (req, res)=>{
  try {
    const { graph_signature, run_id, algo_name, min_steps, best_start_id, time_ms, is_unified, quality, source, flags } = req.body || {}
    if (!graph_signature) return res.status(400).json({ error: 'graph_signature required' })
    const q = quality || ((is_unified===false) ? 'approx' : 'final')
    await RunScore.create({ graph_signature, run_id, algo_name, min_steps, best_start_id, time_ms, is_unified: is_unified!==false, quality: q, source: source||'auto_solve', flags_json: flags||{} })
    if (algo_name) {
      const prev = await AlgoScore.findOne({ algo_name, graph_signature })
      const t = (Number(prev?.total_runs)||0) + 1
      const sPrev = Number(prev?.avg_min_steps)||0
      const mPrev = Number(prev?.avg_time_ms)||0
      const sNext = Number.isFinite(min_steps) ? ((sPrev*(t-1) + (min_steps||0))/t) : sPrev
      const mNext = Number.isFinite(time_ms) ? ((mPrev*(t-1) + (time_ms||0))/t) : mPrev
      const fuPrev = Number(prev?.final_unified_runs)||0
      const fuNext = fuPrev + ((is_unified!==false && q==='final') ? 1 : 0)
      await AlgoScore.updateOne(
        { algo_name, graph_signature },
        { $set: { algo_name, graph_signature, total_runs: t, avg_min_steps: sNext, avg_time_ms: mNext, final_unified_runs: fuNext } },
        { upsert: true }
      )
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Score aggregation per signature (optional algo)
app.get('/api/score/aggregate', async (req, res)=>{
  try {
    const { signature, algo } = req.query || {}
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const q = { graph_signature: signature }
    if (algo) q.algo_name = algo
    const docs = await RunScore.find(q).sort({ createdAt: -1 }).limit(500)
    const total = docs.length
    let sumSteps=0, sumTime=0, finalCount=0
    for(const d of docs){
      sumSteps += Number(d.min_steps)||0
      sumTime += Number(d.time_ms)||0
      if (d.is_unified===true && (d.quality||'final')==='final') finalCount++
    }
    res.json({
      signature,
      total_runs: total,
      avg_min_steps: total ? (sumSteps/total) : 0,
      avg_time_ms: total ? (sumTime/total) : 0,
      final_unified_rate: total ? (finalCount/total) : 0,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Per-algorithm aggregated scores
app.get('/api/score/algo', async (req, res)=>{
  try {
    const { signature } = req.query || {}
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const docs = await AlgoScore.find({ graph_signature: signature }).sort({ updatedAt: -1 })
    res.json(docs.map(d=>({
      algo_name: d.algo_name,
      total_runs: d.total_runs||0,
      final_unified_runs: d.final_unified_runs||0,
      avg_min_steps: d.avg_min_steps||0,
      avg_time_ms: d.avg_time_ms||0,
    })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 新增：学习评分上传，仅正解参与
app.post('/api/learn/score', async (req, res)=>{
  try {
    const { run_id, graph_signature, is_unified, path_len, algo_scores } = req.body || {}
    if (!graph_signature) return res.status(400).json({ error: 'graph_signature required' })
    if (is_unified !== true) return res.json({ ok: true, ignored: true })
    const payload = {
      graph_signature,
      run_id,
      algo_name: 'module',
      min_steps: Number(path_len)||undefined,
      best_start_id: undefined,
      time_ms: undefined,
      is_unified: true,
      quality: 'final',
      source: 'learn_score',
      flags_json: {},
      path_len: Number(path_len)||undefined,
      algo_scores: Array.isArray(algo_scores) ? algo_scores : [],
    }
    if (run_id) {
      await RunScore.updateOne({ run_id }, { $set: payload }, { upsert: true })
    } else {
      await RunScore.create(payload)
    }
    // 聚合每个模块的分数与指标
    if (Array.isArray(algo_scores)){
      for(const s of algo_scores){
        const key = String(s?.key||'')
        if (!key) continue
        const prev = await AlgoScore.findOne({ graph_signature, algorithm_key: key })
        const runsCount = (Number(prev?.runs_count)||0) + 1
        const successCount = (Number(prev?.success_count)||0) + 1
        const totalScore = (Number(prev?.total_score)||0) + (Number(s?.score)||0)
        const avgScore = runsCount>0 ? (totalScore / runsCount) : 0
        const mt = { ...(prev?.metrics_total||{}) }
        const metrics = s?.metrics || {}
        for(const [m,v] of Object.entries(metrics)){
          mt[m] = (Number(mt[m])||0) + (Number(v)||0)
        }
        await AlgoScore.updateOne(
          { graph_signature, algorithm_key: key },
          { $set: { graph_signature, algorithm_key: key, runs_count: runsCount, success_count: successCount, total_score: totalScore, avg_score: avgScore, metrics_total: mt } },
          { upsert: true }
        )
      }
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 学习评分聚合查询（按图签名）
app.get('/api/learn/scores', async (req, res)=>{
  try {
    const { signature } = req.query || {}
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const docs = await AlgoScore.find({ graph_signature: signature, algorithm_key: { $exists: true } }).sort({ updatedAt: -1 })
    res.json(docs.map(d=>({
      graph_signature: d.graph_signature,
      key: d.algorithm_key || d.algo_name,
      runs_count: d.runs_count||0,
      success_count: d.success_count||0,
      total_score: d.total_score||0,
      avg_score: d.avg_score||0,
      metrics_total: d.metrics_total||{},
    })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 管理员查看模块评分聚合（全局/按图）
app.get('/api/admin/scores', authMiddleware, async (req, res)=>{
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query?.limit||'50'), 10) || 50))
    const skip = Math.max(0, parseInt(String(req.query?.skip||'0'), 10) || 0)
    const sig = req.query?.signature
    const q = sig ? { graph_signature: sig, algorithm_key: { $exists: true } } : { algorithm_key: { $exists: true } }
    const docs = await AlgoScore.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit)
    res.json(docs.map(d=>({
      graph_signature: d.graph_signature,
      key: d.algorithm_key || d.algo_name,
      runs_count: d.runs_count||0,
      success_count: d.success_count||0,
      total_score: d.total_score||0,
      avg_score: d.avg_score||0,
      metrics_total: d.metrics_total||{},
    })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// Graph strategy summary: features + strategy per signature
app.get('/api/graphs/strategy', async (req, res)=>{
  try {
    const { signature } = req.query || {}
    if (!signature) return res.status(400).json({ error: 'signature required' })
    const doc = await Strategy.findOne({ graph_signature: signature })
    if (!doc) return res.json(null)
    res.json(doc.strategy_json || null)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/graphs/strategy', async (req, res)=>{
  try {
    const { graph_signature, strategy } = req.body || {}
    if (!graph_signature) return res.status(400).json({ error: 'graph_signature required' })
    await Strategy.updateOne(
      { graph_signature },
      { $set: { graph_signature, strategy_json: strategy || {} } },
      { upsert: true }
    )
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// SAT macro planner: generic Set Cover solver (greedy fallback)
// Body: { universe: [id], sets: [{ id: string, elements: [id] }], k_max?: number }
app.post('/api/sat/set-cover', async (req, res)=>{
  try {
    const { universe, sets, k_max } = req.body || {}
    if (!Array.isArray(universe) || !Array.isArray(sets)) {
      return res.status(400).json({ error: 'universe and sets array required' })
    }
    const U = new Set(universe)
    const remaining = new Set(universe)
    const chosen = []
    const maxK = Number.isFinite(k_max) ? Math.max(1, Math.floor(k_max)) : 16
    const byId = new Map(sets.map(s=>[s.id, new Set(s.elements||[])]))
    let steps = 0
    while(remaining.size>0 && steps < maxK){
      let bestId = null; let bestGain = -1
      for(const [sid, elems] of byId.entries()){
        let gain = 0
        for(const e of elems){ if(remaining.has(e)) gain++ }
        if (gain > bestGain){ bestGain = gain; bestId = sid }
      }
      if (!bestId || bestGain<=0) break
      chosen.push(bestId)
      const elems = byId.get(bestId)
      for(const e of elems){ remaining.delete(e) }
      steps++
    }
    const covered = U.size - remaining.size
    res.json({ chosen, covered })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

mongoose.connect(MONGODB_URI).then(()=>{
  app.listen(PORT, ()=>{ console.log(`[server] listening on http://localhost:${PORT}, db=${MONGODB_URI}`) })
}).catch(err=>{
  console.error('[server] mongo connect error:', err)
  process.exit(1)
})

// Serve frontend static files (one-domain deploy)
try {
  const distDir = path.join(__dirname, '../dist')
  app.use(express.static(distDir))
  // 仅匹配非 /api/* 的 GET 请求，避免盖住后端接口
  app.get(/^\/(?!api\/).*/, (req, res)=>{ res.sendFile(path.join(distDir, 'index.html')) })
} catch {}

// 登录获取令牌（会话内存，不持久化）
app.post('/api/auth/login', (req, res)=>{
  try {
    const { password } = req.body || {}
    if (String(password||'') !== String(ADMIN_PASSWORD||'')) return res.status(401).json({ error: 'invalid_password' })
    const token = crypto.randomBytes(24).toString('hex')
    tokens.add(token)
    res.json({ token })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// 兼容：允许 GET 方式获取令牌（便于运维测试）
app.get('/api/auth/login', (req, res)=>{
  try {
    const password = String(req.query?.password||'')
    if (password !== String(ADMIN_PASSWORD||'')) return res.status(401).json({ error: 'invalid_password' })
    const token = crypto.randomBytes(24).toString('hex')
    tokens.add(token)
    res.json({ token })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// 事件流（SSE）订阅管理
const eventStreams = new Map() // run_id => [res]
function broadcastEvent(run_id, payload){
  const key = String(run_id||'')
  const subs = eventStreams.get(key) || []
  for (const res of subs) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch {}
  }
}
// Admin 列表接口（需鉴权）
app.get('/api/admin/graphs', authMiddleware, async (req, res)=>{
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query?.limit||'50'), 10) || 50))
    const skip = Math.max(0, parseInt(String(req.query?.skip||'0'), 10) || 0)
    const docs = await Graph.find({}).sort({ updated_at: -1 }).skip(skip).limit(limit)
    res.json(docs)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/admin/strategies', authMiddleware, async (req, res)=>{
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query?.limit||'50'), 10) || 50))
    const skip = Math.max(0, parseInt(String(req.query?.skip||'0'), 10) || 0)
    const sig = req.query?.signature
    const q = sig ? { graph_signature: sig } : {}
    const docs = await Strategy.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit)
    res.json(docs)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/admin/runs', authMiddleware, async (req, res)=>{
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query?.limit||'50'), 10) || 50))
    const skip = Math.max(0, parseInt(String(req.query?.skip||'0'), 10) || 0)
    const sig = req.query?.signature
    const q = sig ? { graph_signature: sig } : {}
    const docs = await Run.find(q).sort({ finished_at: -1, started_at: -1 }).skip(skip).limit(limit)
    res.json(docs)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/admin/events', authMiddleware, async (req, res)=>{
  try {
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query?.limit||'200'), 10) || 200))
    const run_id = req.query?.run_id
    const q = run_id ? { run_id } : {}
    const docs = await Event.find(q).sort({ ts: 1 }).limit(limit)
    res.json(docs)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/admin/events/stream', authMiddleware, async (req, res)=>{
  try {
    const run_id = String(req.query?.run_id||'')
    if (!run_id) return res.status(400).json({ error: 'run_id required' })
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders?.()
    res.write(`event: ready\n\n`)
    const subs = eventStreams.get(run_id) || []
    subs.push(res)
    eventStreams.set(run_id, subs)
    req.on('close', ()=>{
      const arr = eventStreams.get(run_id) || []
      eventStreams.set(run_id, arr.filter(r=>r!==res))
      try { res.end() } catch {}
    })
  } catch (e) { try { res.status(500).json({ error: e.message }) } catch {} }
})
app.get('/api/admin/caches', authMiddleware, async (req, res)=>{
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query?.limit||'50'), 10) || 50))
    const skip = Math.max(0, parseInt(String(req.query?.skip||'0'), 10) || 0)
    const sig = req.query?.signature
    const q = sig ? { graph_signature: sig } : {}
    const docs = await Cache.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit)
    res.json(docs)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/admin/recommendations', authMiddleware, async (req, res)=>{
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query?.limit||'50'), 10) || 50))
    const skip = Math.max(0, parseInt(String(req.query?.skip||'0'), 10) || 0)
    const sig = req.query?.signature
    const q = sig ? { graph_signature: sig } : {}
    const docs = await Recommendation.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit)
    res.json(docs)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/admin/ucbs', authMiddleware, async (req, res)=>{
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query?.limit||'50'), 10) || 50))
    const skip = Math.max(0, parseInt(String(req.query?.skip||'0'), 10) || 0)
    const sig = req.query?.signature
    const q = sig ? { graph_signature: sig } : {}
    const docs = await UCB.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit)
    res.json(docs)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// Admin-only: sanitize caches historically marked as final but suspicious
app.post('/api/cache/sanitize', authMiddleware, async (req, res)=>{
  try {
    const { signature, limit, dry_run } = req.body || {}
    const query = signature ? { graph_signature: String(signature) } : {}
    const lim = Math.min(1000, Math.max(1, Number(limit)||200))
    const docs = await Cache.find(query).limit(lim)
    let inspected = 0, changed = 0
    const sample_changes = []
    for (const c of docs){
      inspected++
      const suspicious = isPathSuspicious(c.path)
      const willDemote = suspicious && (c.quality==='final' || c.is_unified===true)
      if (willDemote){
        if (!dry_run){
          await Cache.updateOne({ _id: c._id }, { $set: { quality: 'approx', is_unified: false } })
        }
        changed++
        if (sample_changes.length < 50){ sample_changes.push({ graph_signature: c.graph_signature, reason: 'suspicious_path', old_quality: c.quality, new_quality: 'approx' }) }
      }
    }
    res.json({ inspected, changed, dry_run: !!dry_run, sample_changes })
  } catch (e) { res.status(500).json({ error: e.message }) }
})