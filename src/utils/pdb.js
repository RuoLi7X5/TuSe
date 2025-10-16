// Pattern Database (PDB) skeleton: store and query precomputed costs for small subgraphs.
// This is a placeholder; production PDB needs graph canonicalization and coverage mapping.

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
  // key can identify graph template; data is user-provided cost table
  STORE.set(key, data)
}

export function hasPDB(key){
  return STORE.has(key)
}

// List currently loaded PDB keys for UI/heuristics integration
export function listPDBKeys(){
  try { return Array.from(STORE.keys()) } catch { return [] }
}

// Convenience: load PDB from plain object { signature: cost }
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

// Convenience: load PDB from JSON string
export function loadPDBFromJSON(key, jsonStr){
  try {
    const obj = JSON.parse(jsonStr)
    return loadPDBObject(key, obj)
  } catch { return false }
}

// Resolve PDB base URL from flags, window or env; fallback to '/pdb/'
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

// Load PDB JSON from a URL
export async function loadPDBFromURL(key, url){
  try {
    const res = await fetch(url, { cache: 'force-cache' })
    if(!res.ok) return false
    const obj = await res.json()
    return loadPDBObject(key, obj)
  } catch { return false }
}

// Optional: list remote PDB keys from index.json
export async function listRemotePDBKeys(indexUrl){
  try {
    const res = await fetch(indexUrl, { cache: 'force-cache' })
    if(!res.ok) return []
    const arr = await res.json()
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

// Expose helpers on window for DevTools usage
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

export function estimatePDB(key, env, colors, regionSet){
  // Placeholder: return 0 if not available
  if(!STORE.has(key)) return 0
  const pdb = STORE.get(key)
  // Simple boundary-based signature: color indices around current region boundary
  const { triangles, idToIndex, neighbors, startId } = env || {}
  if(!triangles || !idToIndex || !neighbors || startId==null) return 0
  const rc = colors[idToIndex.get(startId)]
  const boundary = []
  for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ boundary.push(nb) } } }
  // Take up to K boundary nodes to form a micro pattern
  const K = 24
  const sampleIds = boundary.slice(0, K)
  const sampleColors = sampleIds.map(id=> colors[idToIndex.get(id)])
  const { out: canonColors } = canonicalizeColors(sampleColors)
  const sig = canonColors.join(',')
  const val = pdb.get(sig)
  // If present, use it; otherwise fallback to 0 (admissible via max-composition with strict LB)
  return Number.isFinite(val) ? val : 0
}