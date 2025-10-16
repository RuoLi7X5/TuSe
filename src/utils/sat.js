// SAT-based macro planner client utilities
// Provides a generic Set Cover endpoint client and a color macro planner
// that builds a boundary-based set cover and requests a plan order.

export async function satSetCover(universe, sets, kMax = 16, endpoint = '/api/sat/set-cover'){
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ universe, sets, k_max: kMax })
    })
    if (!res.ok) throw new Error(`SAT service error: ${res.status}`)
    const data = await res.json()
    return { chosen: data?.chosen || [], covered: data?.covered || 0 }
  } catch (e) {
    console.warn('[satSetCover] fallback error', e)
    return { chosen: [], covered: 0 }
  }
}

// Build region from start id for local boundary analysis
function buildRegionLocal(triangles, idToIndex, neighbors, colors, startId){
  const rc = colors[idToIndex.get(startId)]
  const rs = new Set(); const q=[startId]; const v=new Set([startId])
  while(q.length){
    const id=q.shift(); const idx=idToIndex.get(id)
    if(colors[idx]!==rc) continue
    rs.add(id)
    for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } }
  }
  return rs
}

// Construct a boundary set cover for colors and request a macro sequence via SAT service
export async function satMacroColorPlan(triangles, startId, palette){
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  const colors = triangles.map(t=>t.color)
  const region = buildRegionLocal(triangles, idToIndex, neighbors, colors, startId)
  const rc = colors[idToIndex.get(startId)]
  const boundary = []
  const boundaryColorMap = new Map()
  for(const tid of region){
    const idx=idToIndex.get(tid)
    for(const nb of neighbors[idx]){
      const nidx=idToIndex.get(nb); const tri=triangles[nidx]
      const c = colors[nidx]
      if(!tri || tri.deleted || c===rc || !c || c==='transparent') continue
      boundary.push(nb)
      const arr = boundaryColorMap.get(c) || []
      arr.push(nb)
      boundaryColorMap.set(c, arr)
    }
  }
  const universe = Array.from(new Set(boundary))
  const sets = []
  const seenColors = new Set()
  for(const [c, ids] of boundaryColorMap.entries()){
    if(seenColors.has(c)) continue
    seenColors.add(c)
    sets.push({ id: c, elements: Array.from(new Set(ids)) })
  }
  if (sets.length===0) return { order: [] }
  const kMax = Math.max(2, Math.min(sets.length, palette?.length || sets.length))
  const res = await satSetCover(universe, sets, kMax)
  return { order: res.chosen || [] }
}