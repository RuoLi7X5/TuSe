// Pattern Database (PDB) skeleton and RAG-based dynamic heuristic
import { buildRAG } from './grid-utils'

const STORE = new Map()

// Canonical mapping: map actual color labels to compact indices per query.
function canonicalizeColors(colors){
  const map = new Map()
  let next = 0
  const out = new Array(colors.length)
  for(let i=0;i<colors.length;i++){
    const c = colors[i]
    if(!c || c==='transparent') { out[i] = -1; continue }
    if(!map.has(c)) { map.set(c, next++) }
    out[i] = map.get(c)
  }
  return { out, map }
}

export function loadPDB(key, data){
  STORE.set(key, data)
}

export function hasPDB(key){
  if(key === 'dynamic_rag') return true
  return STORE.has(key)
}

export function listPDBKeys(){
  const keys = Array.from(STORE.keys())
  keys.push('dynamic_rag')
  return keys
}

export function loadPDBObject(key, obj){
  try {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const map = new Map(Object.entries(obj))
      STORE.set(key, map)
      return true
    }
  } catch {}
  return false
}

export function loadPDBFromJSON(key, jsonStr){
  try {
    const obj = JSON.parse(jsonStr)
    return loadPDBObject(key, obj)
  } catch { return false }
}

export function getPDBBaseURL(){
  try {
    const fromFlags = (typeof window !== 'undefined' && window.SOLVER_FLAGS && window.SOLVER_FLAGS.pdbBaseUrl) ? window.SOLVER_FLAGS.pdbBaseUrl : null
    const fromWindow = (typeof window !== 'undefined' && window.SOLVER_PDB_BASE_URL) ? window.SOLVER_PDB_BASE_URL : null
    let fromEnv = null
    try {
      if (typeof import.meta !== 'undefined' && import.meta && import.meta.env && import.meta.env.VITE_PDB_BASE_URL) {
        fromEnv = import.meta.env.VITE_PDB_BASE_URL
      }
    } catch {}
    const base = fromFlags || fromWindow || fromEnv || '/pdb/'
    return base.endsWith('/') ? base : (base + '/')
  } catch { return '/pdb/' }
}

export async function loadPDBFromURL(key, url){
  try {
    const res = await fetch(url, { cache: 'force-cache' })
    if(!res.ok) return false
    const obj = await res.json()
    return loadPDBObject(key, obj)
  } catch { return false }
}

export async function listRemotePDBKeys(indexUrl){
  try {
    const res = await fetch(indexUrl, { cache: 'force-cache' })
    if(!res.ok) return []
    const arr = await res.json()
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

try {
  if (typeof window !== 'undefined'){
    window.loadPDB = loadPDB
    window.loadPDBObject = loadPDBObject
    window.loadPDBFromJSON = loadPDBFromJSON
    window.loadPDBFromURL = loadPDBFromURL
    window.hasPDB = hasPDB
    window.listPDBKeys = listPDBKeys
    window.listRemotePDBKeys = listRemotePDBKeys
    window.getPDBBaseURL = getPDBBaseURL
  }
} catch {}

function estimateDynamicRAG(env, colors, regionSet){
  const { triangles, idToIndex, startId, boundaryNeighbors } = env
  if(!triangles || !idToIndex || startId==null) return 0
  
  // Cache RAG and Distances on the triangles object (or a dedicated cache if passed)
  if(!triangles._ragCache){
    const rag = buildRAG(triangles)
    const startIdx = idToIndex.get(startId)
    const startComp = rag.triToComp[startIdx]
    if(startComp === undefined) { triangles._ragCache = { maxDist:0, dists:[] }; return 0 }
    
    const dists = new Int32Array(rag.components.length).fill(-1)
    const q = [startComp]
    dists[startComp] = 0
    let maxDist = 0
    
    let head = 0
    while(head < q.length){
      const u = q[head++]
      const d = dists[u]
      if(d > maxDist) maxDist = d
      const adjs = rag.compAdj[u]
      for(const v of adjs){
        if(dists[v] === -1){
          dists[v] = d + 1
          q.push(v)
        }
      }
    }
    triangles._ragCache = { rag, dists, maxDist }
  }
  
  const { rag, dists, maxDist } = triangles._ragCache
  if(maxDist === 0) return 0
  
  // If boundaryNeighbors (indices) provided, use them for O(Boundary) check
  if(boundaryNeighbors && Array.isArray(boundaryNeighbors)){
    let minD = maxDist + 1
    for(const idx of boundaryNeighbors){
      const cId = rag.triToComp[idx]
      if(cId !== undefined){
        const d = dists[cId]
        if(d !== -1 && d < minD) minD = d
      }
    }
    // If we have valid boundary neighbors, the "cleared radius" is roughly minD.
    // Remaining steps >= maxDist - minD.
    if(minD > maxDist) return 0 // Boundary empty or all unreachable?
    return Math.max(0, maxDist - minD)
  }
  
  return 0
}

export function estimatePDB(key, env, colors, regionSet){
  if(key === 'dynamic_rag') {
    return estimateDynamicRAG(env, colors, regionSet)
  }

  if(!STORE.has(key)) return 0
  const pdb = STORE.get(key)
  const { triangles, idToIndex, neighbors, startId } = env || {}
  if(!triangles || !idToIndex || !neighbors || startId==null) return 0
  const rc = colors[idToIndex.get(startId)]
  
  // Reconstruct boundary if not provided
  let boundary = []
  // This part is slow if regionSet is large. 
  // Ideally use env.boundaryNeighbors if available and convert to IDs?
  // PDB stored keys might rely on IDs or specific ordering.
  // For now, keep original logic for static PDBs.
  for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ boundary.push(nb) } } }
  
  const K = 24
  const sampleIds = boundary.slice(0, K)
  const sampleColors = sampleIds.map(id=> colors[idToIndex.get(id)])
  const { out: canonColors } = canonicalizeColors(sampleColors)
  const sig = canonColors.join(',')
  const val = pdb.get(sig)
  return Number.isFinite(val) ? val : 0
}
