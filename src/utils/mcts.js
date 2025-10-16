// MCTS skeleton for approximate solutions.
// Provides a time-budgeted search that returns a heuristic sequence quickly.

export async function mctsSolve(triangles, startId, palette, timeBudgetMs = 1000, onProgress){
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  const startColors = triangles.map(t=>t.color)
  const startTs = Date.now()
  let best = null

  function isUniform(colors){
    const rc = colors[idToIndex.get(startId)]
    for(let i=0;i<colors.length;i++){
      const t=triangles[i]; const c=colors[i]
      if(!t.deleted && c && c!=='transparent' && c!==rc) return false
    }
    return true
  }

  function expandRegion(colors){
    const rc = colors[idToIndex.get(startId)]
    const rs = new Set(); const q=[startId]; const v=new Set([startId])
    while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
    return rs
  }

  function orderColors(colors, regionSet){
    const rc = colors[idToIndex.get(startId)]
    const gain = new Map(); const adj = new Set()
    for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const c=colors[nidx]; if(c!==rc && c && c!=='transparent' && !tri.deleted){ adj.add(c); gain.set(c,(gain.get(c)||0)+1) } } }
    return (adj.size>0 ? [...adj] : palette).sort((a,b)=> (gain.get(b)||0) - (gain.get(a)||0))
  }

  // Time-budgeted rollout policy (greedy + random tie-breaker)
  while(Date.now() - startTs < timeBudgetMs){
    let colors = startColors.slice()
    const steps = []
    let guard = 0
    const limit = Math.min(100, triangles.length)
    while(!isUniform(colors) && guard < limit){
      const region = expandRegion(colors)
      const choices = orderColors(colors, region)
      const pick = choices[Math.floor(Math.random() * choices.length)]
      const rc = colors[idToIndex.get(startId)]
      if(pick===rc){ guard++; continue }
      for(const id of region){ const ii=idToIndex.get(id); colors[ii] = pick }
      steps.push(pick)
      guard++
    }
    if(!best || (steps.length < (best?.steps?.length||Infinity))){ best = { steps } }
    if(onProgress){ try { onProgress({ phase:'mcts_rollout', steps: steps.length }) } catch {}
    }
  }
  return { path: best?.steps||[], minSteps: best?.steps?.length||0 }
}