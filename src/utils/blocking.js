// Coarse-to-Fine blocking skeleton: partition graph into blocks, plan macro search.
// Blocks are sets of triangle ids; this is a placeholder for future structured search.

export function partitionBlocks(triangles, options = {}){
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  const blocks = []
  const visited = new Set()
  const MAX_BLOCK_SIZE = Number.isFinite(options.maxBlockSize) ? options.maxBlockSize : 64
  for(const t of triangles){
    if(!t || visited.has(t.id) || t.deleted || t.color==='transparent') continue
    const block = new Set()
    const q=[t.id]; visited.add(t.id)
    while(q.length && block.size < MAX_BLOCK_SIZE){
      const u=q.shift(); block.add(u)
      const ui=idToIndex.get(u)
      for(const v of neighbors[ui]){
        const vi=idToIndex.get(v); const tv=triangles[vi]
        if(tv && !tv.deleted && tv.color!=="transparent" && !visited.has(v)){
          visited.add(v); q.push(v)
        }
      }
    }
    blocks.push(block)
  }
  return blocks
}

export function planBlockAStar(triangles, blocks, startId, palette, onProgress){
  // 构建块图：节点为块，边为跨块相邻关系
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  const blockIndexById = new Map()
  blocks.forEach((b,bi)=>{ for(const id of b){ blockIndexById.set(id, bi) } })
  const edges = Array(blocks.length).fill(0).map(()=> new Set())
  for(let bi=0; bi<blocks.length; bi++){
    for(const id of blocks[bi]){
      const idx = idToIndex.get(id)
      for(const nb of neighbors[idx]){
        const bj = blockIndexById.get(nb)
        if(bj!=null && bj!==bi){ edges[bi].add(bj); edges[bj].add(bi) }
      }
    }
  }
  // 选择起始块
  const startBlock = blockIndexById.get(startId) ?? 0
  // 基于宏观启发式的简单 A*：按边界度与颜色频率综合评分选择下一个块
  const colorFreq = new Map()
  for(const t of triangles){ const c=t.color; if(!t.deleted && c && c!=='transparent'){ colorFreq.set(c,(colorFreq.get(c)||0)+1) } }
  const boundaryColorSet = (bi)=>{
    const set = new Set()
    for(const id of blocks[bi]){
      const idx=idToIndex.get(id)
      const rc = triangles[idx].color
      for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=tri?.color; if(cc && cc!==rc && cc!=='transparent' && !tri?.deleted){ set.add(cc) } }
    }
    return set
  }
  const boundaryDegree = edges.map(e=> e.size)
  const boundaryColors = edges.map((_,i)=> boundaryColorSet(i))
  // A*
  const open=[{ blocksCovered: new Set([startBlock]), order:[startBlock], g:0, f:0 }]
  const seen = new Set()
  const packKey = (covered)=> Array.from(covered).sort((a,b)=>a-b).join(',')
  const totalBlocks = blocks.length
  while(open.length){
    open.sort((a,b)=> a.f-b.f)
    const cur = open.shift()
    const key = packKey(cur.blocksCovered)
    if(seen.has(key)) continue
    seen.add(key)
    if(cur.blocksCovered.size>=totalBlocks){
      try { onProgress?.({ phase:'blocking_plan', blocks: blocks.length, order: cur.order }) } catch {}
      return { blocks, edges: edges.map(e=>Array.from(e)), order: cur.order, startBlock }
    }
    // 候选为当前已覆盖的块的邻接块集合
    const cand=new Set()
    for(const bi of cur.blocksCovered){ for(const bj of edges[bi]){ if(!cur.blocksCovered.has(bj)) cand.add(bj) } }
    if(cand.size===0){
      // 孤立块（无边），选择尚未覆盖的任意块
      for(let i=0;i<blocks.length;i++){ if(!cur.blocksCovered.has(i)) cand.add(i) }
    }
    for(const bj of cand){
      // 评分：边界度 + 边界颜色频率（越大越优先）
      let score = boundaryDegree[bj] * 2
      for(const c of boundaryColors[bj]){ score += (colorFreq.get(c)||0) * 0.2 }
      // 简单下界：剩余块数
      const h = Math.max(0, blocks.length - (cur.blocksCovered.size+1))
      const g = cur.g + 1
      const f = g + h - score*0.01
      const nextCovered = new Set(cur.blocksCovered); nextCovered.add(bj)
      open.push({ blocksCovered: nextCovered, order: [...cur.order, bj], g, f })
    }
  }
  // 兜底：按边界度降序
  const order = edges.map((e,i)=>({i,deg:e.size})).sort((a,b)=>b.deg-a.deg).map(x=>x.i)
  try { onProgress?.({ phase:'blocking_plan', blocks: blocks.length, order }) } catch {}
  return { blocks, edges: edges.map(e=>Array.from(e)), order, startBlock }
}

export function executeBlockPlan(triangles, blocks, order, palette, onProgress){
  // 将块级计划落地：对每个块生成子图，交由严格求解器求解，并拼接路径。
  // 为避免循环依赖，这里通过 window.StrictIDAStarMinSteps 调用。
  async function solveBlock(bi){
    const ids = blocks[bi]
    const idSet = new Set(ids)
    const sub = triangles.map(t=>{
      const inBlock = idSet.has(t.id)
      return inBlock ? { ...t } : { ...t, deleted: true }
    })
    const startId = Array.from(idSet)[0]
    const res = await window.StrictIDAStarMinSteps?.(sub, startId, palette, (p)=>{ try { onProgress?.({ phase:'block_subsearch', block: bi, ...p }) } catch {} }, window.SOLVER_FLAGS?.blockStepLimit ?? Infinity)
    return res?.paths?.[0] || []
  }
  return (async ()=>{
    const fullPath=[]
    for(const bi of order){ const p = await solveBlock(bi); fullPath.push(...p) }
    try { onProgress?.({ phase:'block_plan_done', steps: fullPath.length }) } catch {}
    return fullPath
  })()
}