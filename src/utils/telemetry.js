// Minimal telemetry client: compute graph signature/features and post to server
// 默认后端地址：在开发环境使用 localhost:3001；在生产环境优先同域
const defaultBase = (function(){
  if (typeof window === 'undefined') return 'http://localhost:3001'
  try {
    const isLocal = String(window.location.hostname||'').toLowerCase() === 'localhost'
    return isLocal ? 'http://localhost:3001' : (window.location.origin || '')
  } catch {
    return 'http://localhost:3001'
  }
})()

function djb2(str){
  let h = 5381
  for(let i=0;i<str.length;i++){ h = ((h<<5)+h) + str.charCodeAt(i); h|=0 }
  return (h>>>0).toString(16)
}

export function makeGraphSignature(triangles, palette){
  try{
    const ids = triangles.map(t=>t.id).join(',')
    const colors = triangles.map(t=>t.color||'').join(',')
    const edges = triangles.map(t=>`${t.id}:${(t.neighbors||[]).join('-')}`).join('|')
    return djb2(ids+'#'+colors+'#'+edges+'#'+(palette||[]).join(','))
  }catch{ return djb2('fallback') }
}

export function computeFeatures(triangles, palette){
  const palette_size = (palette||[]).length
  const n_triangles = (triangles||[]).length
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const colors = triangles.map(t=>t.color)
  const neighbors = triangles.map(t=>t.neighbors||[])
  // components by color
  let n_components = 0
  const visited = new Set()
  for(const t of triangles){
    if(visited.has(t.id) || t.deleted) continue
    const c = t.color
    const q=[t.id]; visited.add(t.id)
    while(q.length){
      const id=q.shift(); const idx=idToIndex.get(id)
      for(const nb of neighbors[idx]){
        if(!visited.has(nb)){
          const nidx=idToIndex.get(nb)
          if(colors[nidx]===c && !triangles[nidx].deleted){ visited.add(nb); q.push(nb) }
        }
      }
    }
    n_components++
  }
  // boundary length & bridge density
  let boundaryEdges=0, totalEdges=0, bridgeEdges=0
  for(let i=0;i<triangles.length;i++){
    const c = colors[i]
    for(const nb of neighbors[i]||[]){
      totalEdges++
      const nidx=idToIndex.get(nb)
      const nc=colors[nidx]
      if(c!==nc) { boundaryEdges++; bridgeEdges++ }
    }
  }
  const boundary_len = boundaryEdges
  const bridge_density = totalEdges>0 ? bridgeEdges/totalEdges : 0
  // dispersion by color frequency
  const freq = new Map()
  for(const c of colors){ if(!c || c==='transparent') continue; freq.set(c,(freq.get(c)||0)+1) }
  const arr=[...freq.values()]; const mean=(arr.reduce((a,b)=>a+b,0)/(arr.length||1))||0
  const variance = arr.reduce((a,b)=>a+(b-mean)*(b-mean),0)/(arr.length||1)
  const dispersion_avg = variance
  const color_entropy = (function(){
    const sum = arr.reduce((a,b)=>a+b,0)||1
    let e=0; for(const x of arr){ const p=x/sum; e += p>0 ? -p*Math.log2(p):0 }
    return e
  })()
  return { palette_size, n_triangles, n_components, bridge_density, dispersion_avg, boundary_len, color_entropy }
}

async function postJSON(path, body){
  const base = (typeof window !== 'undefined' && window.SOLVER_FLAGS?.serverBaseUrl) || defaultBase
  const url = `${base}${path}`
  const res = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body||{}) })
  if(!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function getJSON(path){
  const base = (typeof window !== 'undefined' && window.SOLVER_FLAGS?.serverBaseUrl) || defaultBase
  const url = `${base}${path}`
  const res = await fetch(url)
  if(!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

export async function startRun(triangles, palette, flags){
  if(!(typeof window !== 'undefined' && window.SOLVER_FLAGS?.enableTelemetry)) return null
  const graph_signature = makeGraphSignature(triangles, palette)
  const features = computeFeatures(triangles, palette)
  try{
    const r = await postJSON('/api/runs/start', { graph_signature, features, flags })
    return { runId: r.run_id, graphSignature: graph_signature }
  }catch{ return { runId: null, graphSignature: graph_signature } }
}

export async function logEvent(runId, payload){
  if(!runId || !(typeof window !== 'undefined' && window.SOLVER_FLAGS?.enableTelemetry)) return
  try{ await postJSON('/api/events', { run_id: runId, ...payload }) }catch{}
}

export async function finishRun(runId, data){
  if(!runId || !(typeof window !== 'undefined' && window.SOLVER_FLAGS?.enableTelemetry)) return
  try{ await postJSON('/api/runs/finish', { run_id: runId, ...data }) }catch{}
}

export async function getRecommendation(signature){
  try{ return await getJSON(`/api/recommend/params?signature=${encodeURIComponent(signature)}`) }catch{ return null }
}

export async function getCachePath(signature){
  try{ return await getJSON(`/api/cache/path?signature=${encodeURIComponent(signature)}`) }catch{ return null }
}

export async function putCachePath(graph_signature, data){
  try{ return await postJSON('/api/cache/path', { graph_signature, ...data }) }catch{ return null }
}

// UCB stats aggregation endpoints
export async function getUCBStats(signature){
  try{ return await getJSON(`/api/learn/ucb?signature=${encodeURIComponent(signature)}`) }catch{ return null }
}
export async function putUCBStats(graph_signature, data){
  try{ return await postJSON('/api/learn/ucb', { graph_signature, ...data }) }catch{ return null }
}

// Strategy summary: compute and upload/get
export function computeStrategySummary(triangles, palette, startId, path, flags, mode){
  const features = computeFeatures(triangles, palette)
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const colors = triangles.map(t=>t.color)
  const startColor = (startId!=null && idToIndex.has(startId)) ? colors[idToIndex.get(startId)] : null
  const seq = Array.isArray(path) ? path.slice() : []
  const color_counts = {}
  let transitions = 0, longest = 0, curStreak = 0, prev = null
  for(const c of seq){
    color_counts[c] = (color_counts[c]||0) + 1
    if(prev==null){ curStreak = 1 } else { curStreak = (c===prev) ? (curStreak+1) : 1 }
    if(prev!=null && c!==prev) transitions++
    if(curStreak>longest) longest = curStreak
    prev = c
  }
  const unique_colors_used = Object.keys(color_counts).length
  return {
    mode: mode || 'auto',
    start_id: startId ?? null,
    start_color: startColor ?? null,
    path_len: seq.length,
    transitions_count: transitions,
    longest_streak: longest,
    unique_colors_used,
    color_counts,
    flags: { ...(flags||{}) },
    features,
  }
}

export async function getStrategySummary(signature){
  try{ return await getJSON(`/api/graphs/strategy?signature=${encodeURIComponent(signature)}`) }catch{ return null }
}

export async function putStrategySummary(graph_signature, strategy){
  try{ return await postJSON('/api/graphs/strategy', { graph_signature, strategy }) }catch{ return null }
}

export async function uploadStrategyAuto(triangles, palette, mode, startId, path, criticalNodes){
  try{
    if(!(typeof window !== 'undefined' && window.SOLVER_FLAGS?.enableTelemetry)) return
    const graph_signature = makeGraphSignature(triangles, palette)
    const summary = computeStrategySummary(triangles, palette, startId, path, (typeof window!=='undefined'?window.SOLVER_FLAGS:{}), mode)
    if (criticalNodes && Array.isArray(criticalNodes)) summary.critical_nodes = criticalNodes
    await putStrategySummary(graph_signature, summary)
  }catch{}
}