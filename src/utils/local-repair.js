// Local repair and compression utilities for solution paths
// Greedy removal of redundant steps and micro-optimizations with safe uniformity checks

export async function localRepair(triangles, palette, startId, path, onProgress){
  try { onProgress?.({ phase:'local_repair_start', length: path.length }) } catch {}
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))

  const isUniformFast = (colorsArr)=>{
    let first=null
    for(let i=0;i<triangles.length;i++){
      const t=triangles[i]; const c=colorsArr[i]
      if(t.deleted || !c || c==='transparent') continue
      if(first===null){ first=c } else if(c!==first){ return false }
    }
    return first!==null
  }

  const applyPath = (colors, p)=>{
    let cur = colors.slice()
    for(const color of p){
      // flood fill from startId over current region color
      const startColor = cur[idToIndex.get(startId)]
      if(color===startColor) continue
      const visited=new Set([startId])
      const q=[startId]
      const region=[]
      while(q.length){
        const id=q.shift()
        const idx=idToIndex.get(id)
        if(cur[idx]!==startColor) continue
        region.push(id)
        for(const nb of triangles[idx].neighbors){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } }
      }
      for(const id of region){ cur[idToIndex.get(id)] = color }
    }
    return cur
  }

  const gainAt = (colors, p, i)=>{
    // region size before and after step i
    const before = colors.slice()
    const prefix = p.slice(0,i)
    const afterPrefix = applyPath(before, prefix)
    const startColor = afterPrefix[idToIndex.get(startId)]
    const visited=new Set([startId])
    const q=[startId]
    const region=[]
    while(q.length){
      const id=q.shift(); const idx=idToIndex.get(id)
      if(afterPrefix[idx]!==startColor) continue
      region.push(id)
      for(const nb of triangles[idx].neighbors){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } }
    }
    const sizeBefore = region.length
    const next = afterPrefix.slice()
    const color = p[i]
    for(const id of region){ next[idToIndex.get(id)] = color }
    // expand new region after color
    const visited2=new Set([startId])
    const q2=[startId]
    const region2=[]
    while(q2.length){
      const id=q2.shift(); const idx=idToIndex.get(id)
      if(next[idx]!==color) continue
      region2.push(id)
      for(const nb of triangles[idx].neighbors){ if(!visited2.has(nb)){ visited2.add(nb); q2.push(nb) } }
    }
    const sizeAfter = region2.length
    return Math.max(0, sizeAfter - sizeBefore)
  }

  let baseColors = triangles.map(t=>t.color)
  let curPath = Array.isArray(path) ? [...path] : []
  let changed = true
  let passes = 0
  const MAX_PASSES = 2
  while(changed && passes < MAX_PASSES){
    changed = false
    passes += 1
    // Pass 0: 移除相邻重复颜色（安全）
    for(let i=1;i<curPath.length;i++){
      if(curPath[i] === curPath[i-1]){
        const tryPath = curPath.slice(0,i-1).concat(curPath.slice(i))
        const endColors = applyPath(baseColors, tryPath)
        if(isUniformFast(endColors)){
          curPath = tryPath
          changed = true
          i -= 1
        }
      }
    }
    // Pass 1: remove zero-gain steps if safe
    for(let i=0;i<curPath.length;i++){
      const g = gainAt(baseColors, curPath, i)
      if(g<=0){
        const tryPath = curPath.slice(0,i).concat(curPath.slice(i+1))
        const endColors = applyPath(baseColors, tryPath)
        if(isUniformFast(endColors)){
          curPath = tryPath
          changed = true
          i -= 1
        }
      }
    }
    // Pass 2: collapse XYX -> YX if safe
    for(let i=2;i<curPath.length;i++){
      if(curPath[i] === curPath[i-2]){
        const tryPath = curPath.slice(0,i-1).concat(curPath.slice(i))
        const endColors = applyPath(baseColors, tryPath)
        if(isUniformFast(endColors)){
          curPath = tryPath
          changed = true
          i -= 1
        }
      }
    }
  }

  // 试验性：小窗口相邻交换以提升早期增益（安全检查）
  try {
    const W = Math.max(2, Math.min(5, (typeof window!=='undefined' && window.SOLVER_FLAGS && window.SOLVER_FLAGS.optimizeWindowSize) ? window.SOLVER_FLAGS.optimizeWindowSize : 5))
    const swapPasses = Math.max(0, (typeof window!=='undefined' && window.SOLVER_FLAGS && window.SOLVER_FLAGS.optimizeSwapPasses) ? window.SOLVER_FLAGS.optimizeSwapPasses : 1)
    for(let pass=0; pass<swapPasses; pass++){
      let swapped = false
      for(let i=0;i+1<curPath.length;i++){
        // 在窗口范围内考虑交换相邻步骤
        const j = i+1
        const tryPath = curPath.slice(0,i).concat([curPath[j], curPath[i]], curPath.slice(j+1))
        const endColors = applyPath(baseColors, tryPath)
        if(isUniformFast(endColors)){
          // 简单规则：若交换后窗口内前两步的增益总和更高，则采用
          const g1 = gainAt(baseColors, tryPath, i)
          const g2 = (i+1 < tryPath.length) ? gainAt(baseColors, tryPath, i+1) : 0
          const g1o = gainAt(baseColors, curPath, i)
          const g2o = gainAt(baseColors, curPath, i+1)
          if((g1+g2) > (g1o+g2o)){
            curPath = tryPath
            swapped = true
          }
        }
      }
      if(!swapped) break
    }
  } catch {}

  try { onProgress?.({ phase:'local_repair_done', length: curPath.length }) } catch {}
  return { path: curPath }
}