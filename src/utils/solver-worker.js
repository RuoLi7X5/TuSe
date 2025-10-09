// Web Worker for parallel auto-solve
// Runs the enhanced solver in a dedicated thread and streams progress back to main thread.

// Minimal helpers (avoid DOM dependencies)
function keyFromColors(colors){ return colors.join(',') }
function isUniformSimple(triangles){
  if (!triangles || triangles.length === 0) return false
  const active = triangles.filter(t => !t.deleted && t.color !== 'transparent')
  if (active.length === 0) return false
  const c = active[0].color
  return active.every(t => t.color === c)
}

async function Solver_minSteps(triangles, startId, palette, maxBranches=3, onProgress, stepLimit=Infinity){
  const startTime = Date.now()
  // 计算时限：可通过 SOLVER_FLAGS.workerTimeBudgetMs 配置（默认 300000 ms）
  const TIME_BUDGET_MS = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.workerTimeBudgetMs))
    ? Math.max(1000, self.SOLVER_FLAGS.workerTimeBudgetMs)
    : 300000
  let timedOut = false
  const startColor = triangles.find(t=>t.id===startId)?.color
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  // 可选开关（默认关闭）：从全局覆写
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  const ENABLE_LB = !!FLAGS.enableLB
  const ENABLE_LOOKAHEAD = !!FLAGS.enableLookahead
  const ENABLE_INCREMENTAL = !!FLAGS.enableIncremental
  const ENABLE_BEAM = !!FLAGS.enableBeam
  const BEAM_WIDTH = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
  const ENABLE_BEST_FIRST = !!FLAGS.enableBestFirst
  const ENABLE_BRIDGE_FIRST = !!FLAGS.enableBridgeFirst
  const ADJ_AFTER_WEIGHT = Number.isFinite(FLAGS?.adjAfterWeight) ? FLAGS.adjAfterWeight : 0.6
  const BOUNDARY_WEIGHT = Number.isFinite(FLAGS?.boundaryWeight) ? FLAGS.boundaryWeight : 0.8
  const REGION_CLASS_WEIGHTS = FLAGS?.regionClassWeights || { boundary: 0.8, bridge: 1.0, richness: 0.6 }
  const DIM_WEIGHTS = FLAGS?.dimensionWeights || { expand: 1.0, connect: 0.8, barrier: 0.7 }
  // 新增开关：零扩张候选过滤与性能日志
  const ENABLE_ZERO_FILTER = (FLAGS.enableZeroExpandFilter !== false)
  const LOG_PERF = !!FLAGS.logPerf
  // 稀有颜色与“准零扩张”/下界改进的过滤阈值（可调）
  const RARE_FREQ_RATIO = Number.isFinite(FLAGS?.rareFreqRatio) ? FLAGS.rareFreqRatio : 0.03
  const RARE_FREQ_ABS = Number.isFinite(FLAGS?.rareFreqAbs) ? FLAGS.rareFreqAbs : 3
  const RARE_ALLOW_BRIDGE_MIN = Number.isFinite(FLAGS?.rareAllowBridgeMin) ? FLAGS.rareAllowBridgeMin : 2.0
  const MIN_DELTA_RATIO = Number.isFinite(FLAGS?.minDeltaRatio) ? FLAGS.minDeltaRatio : 0.02
  const LB_IMPROVE_MIN = Number.isFinite(FLAGS?.lbImproveMin) ? FLAGS.lbImproveMin : 1

  function computeAdjAfterSize(color, curColors, regionSet){
    // 预演一步应用 color 后的新区域相邻颜色种类数（轻量版，无 RAG 依赖）
    const tmp = curColors.slice()
    for(const id of regionSet){ tmp[idToIndex.get(id)] = color }
    const newRegion = new Set([...regionSet])
    const q=[...regionSet]
    const visited2=new Set([...regionSet])
    while(q.length){
      const tid=q.shift(); const idx=idToIndex.get(tid)
      for(const nb of neighbors[idx]){
        const nidx=idToIndex.get(nb); if(nidx==null) continue
        const tri=triangles[nidx]; const cc=tmp[nidx]
        if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && cc===color){ visited2.add(nb); newRegion.add(nb); q.push(nb) }
      }
    }
    const adjSet = new Set()
    for(const tid of newRegion){
      const idx=idToIndex.get(tid)
      for(const nb of neighbors[idx]){
        const nidx=idToIndex.get(nb); if(nidx==null) continue
        const tri=triangles[nidx]; const cc=tmp[nidx]
        if(!tri.deleted && cc && cc!=='transparent' && cc!==color){ adjSet.add(cc) }
      }
    }
    return adjSet.size
  }
  function lowerBound(colors){
    const s = new Set()
    for(let i=0;i<triangles.length;i++){
      const t = triangles[i]; const c = colors[i]
      if(!t.deleted && c && c!=='transparent') s.add(c)
    }
    return Math.max(0, s.size - 1)
  }

  // 初始区域
  const region = []
  const visited = new Set([startId])
  const queue=[startId]
  while(queue.length){
    const id=queue.shift()
    const t=triangles[idToIndex.get(id)]
    if(t.deleted || t.color==='transparent' || t.color!==startColor) continue
    region.push(id)
    for(const nb of t.neighbors){ if(!visited.has(nb)){ visited.add(nb); queue.push(nb) } }
  }

  const startColors = triangles.map(t=>t.color)
  const startKey = keyFromColors(startColors)
  const seen = new Set([startKey])
  const maxNodes = Math.min(20000, Math.max(8000, triangles.length * 8))
  const queueStates = [{ colors:startColors, region: new Set(region), steps: [] }]
  const solutions = []
  // 在步数上限内记录最佳部分方案（颜色种类最少，区域最大）
  let bestPartial = { steps: [], score: Infinity, regionSize: 0 }
  let maxDepth = 0
  let nodes = 0
  const perf = { filteredZero: 0, expanded: 0, enqueued: 0 }
  while(queueStates.length && nodes<maxNodes){
    if (nodes % 300 === 0) {
      if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break }
      await new Promise(r=>setTimeout(r,0))
      onProgress?.({ phase: 'search', nodes, queue: queueStates.length, solutions: solutions.length, elapsedMs: Date.now() - startTime, maxDepth, perf })
    }
    const cur = queueStates.shift(); nodes++
    const curColors = cur.colors
    // 剪枝：超过步数上限不再扩展
    if (cur.steps.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
      continue
    }
    // LB 早停：若剩余下界超过可用步数则剪枝
    if (ENABLE_LB && Number.isFinite(stepLimit)){
      const lb = lowerBound(curColors)
      if (cur.steps.length + lb > stepLimit) {
        continue
      }
    }
    if(isUniformSimple(curColors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))){
      // 若开启“先返回可行解”，立即返回当前路径（可能不是全局最短）
      if ((self.SOLVER_FLAGS?.returnFirstFeasible) && Number.isFinite(stepLimit)) {
        onProgress?.({ phase: 'solution', minSteps: cur.steps.length, solutions: 1, elapsedMs: Date.now() - startTime })
        return { paths: [cur.steps], minSteps: cur.steps.length, timedOut }
      }
      solutions.push(cur.steps)
      const minLen = solutions[0].length
      const sameLen = solutions.filter(s=>s.length===minLen)
      onProgress?.({ phase: 'solution', minSteps: minLen, solutions: sameLen.length, elapsedMs: Date.now() - startTime })
      if(sameLen.length>=maxBranches) break
      else continue
    }
    const regionSet = cur.region
    // 评估当前状态：尽量减少颜色种类，若相同则区域更大更优
    {
      const activeColors = new Set()
      for(let i=0;i<triangles.length;i++){
        const t=triangles[i]; const c=curColors[i]
        if(!t.deleted && c && c!=='transparent') activeColors.add(c)
      }
      const distinctCount = activeColors.size
      if (distinctCount < bestPartial.score || (distinctCount===bestPartial.score && regionSet.size > bestPartial.regionSize)) {
        bestPartial = { steps: cur.steps, score: distinctCount, regionSize: regionSet.size }
      }
    }
    const regionColor = curColors[idToIndex.get(startId)]

    // 邻接颜色与增益（优先使用增量边界缓存）
    const adjColors = new Set()
    const gain = new Map()
    if (ENABLE_INCREMENTAL && cur.boundaryNeighbors && Array.isArray(cur.boundaryNeighbors)) {
      for (const nb of cur.boundaryNeighbors) {
        const nidx = idToIndex.get(nb)
        if (nidx == null) continue
        const tri = triangles[nidx]
        const c = curColors[nidx]
        if (c!==regionColor && c && c!=='transparent' && !tri.deleted){
          adjColors.add(c)
          gain.set(c, (gain.get(c) || 0) + 1)
        }
      }
    } else {
      for(const tid of regionSet){
        const idx = idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx = idToIndex.get(nb)
          const tri = triangles[nidx]
          const c = curColors[nidx]
          if (c!==regionColor && c && c!=='transparent' && !tri.deleted){
            adjColors.add(c)
            gain.set(c, (gain.get(c) || 0) + 1)
          }
        }
      }
    }
    const colorCount = new Map()
    for(const t of triangles){ if(!t.deleted && t.color && t.color!=='transparent'){ colorCount.set(t.color, (colorCount.get(t.color)||0)+1) } }
    const tryColorsRaw = adjColors.size>0 ? [...adjColors] : palette
    const boundaryBefore = adjColors.size
    const basePreK = 6
    const preK = ENABLE_BEAM ? Math.min(BEAM_WIDTH, basePreK) : basePreK
    const prelim = tryColorsRaw.map(c=>{
      const g = (gain.get(c)||0)
      const freq = (colorCount.get(c)||0)
      const score0 = g*3 + freq*0.5
      return { c, score0, gain:g }
    }).sort((a,b)=> b.score0 - a.score0).slice(0, preK)
    // 边界同色聚类规模估计
    const regionBoundaryNeighbors = []
    for(const tid of regionSet){
      const idx = idToIndex.get(tid)
      for(const nb of neighbors[idx]){
        const nidx = idToIndex.get(nb)
        if (nidx==null) continue
        if (curColors[nidx] !== regionColor){ regionBoundaryNeighbors.push(nb) }
      }
    }
    const enlargePotential = new Map()
    const saddlePotential = new Map()
    for(const {c} of prelim){
      const seeds = []
      for(const nb of regionBoundaryNeighbors){ const nbIdx=idToIndex.get(nb); if(nbIdx!=null && curColors[nbIdx]===c){ seeds.push(nb) } }
      // 并集扩张潜力
      const seenUnion = new Set(seeds); const qUnion=[...seeds]
      while(qUnion.length){ const u=qUnion.shift(); const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx!=null && curColors[vIdx]===c && !seenUnion.has(v)){ seenUnion.add(v); qUnion.push(v) } } }
      enlargePotential.set(c, seenUnion.size + regionSet.size)
      // 双前沿saddle潜力：统计边界上颜色 c 的分量前两大之和
      const visited = new Set(); const compSizes=[]
      for(const s of seeds){ if(visited.has(s)) continue; let size=0; const q=[s]; visited.add(s); while(q.length){ const u=q.shift(); size++; const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx==null) continue; if(!visited.has(v) && curColors[vIdx]===c){ visited.add(v); q.push(v) } } } compSizes.push(size) }
      compSizes.sort((a,b)=>b-a)
      const top2 = (compSizes[0]||0) + (compSizes[1]||0)
      saddlePotential.set(c, compSizes.length>=2 ? top2 : 0)
    }
    const limitTry = 8
    const prevLB = ENABLE_LB ? lowerBound(curColors) : 0
    const BF_W = Number.isFinite(self?.SOLVER_FLAGS?.bifrontWeight) ? self.SOLVER_FLAGS.bifrontWeight : 2.0
    const tryColors = prelim
      .map(({c, gain})=>{ 
        const freq=(colorCount.get(c)||0); 
        const pot=(enlargePotential.get(c)||0); 
        const saddle=(saddlePotential.get(c)||0);
        let score=gain*3 + freq*0.5 + pot*2 + saddle*BF_W; 
        if (ENABLE_BRIDGE_FIRST){
          const adjAfter = computeAdjAfterSize(c, curColors, regionSet)
          score += (boundaryBefore - adjAfter) * BOUNDARY_WEIGHT
          score += adjAfter * ADJ_AFTER_WEIGHT
          const expandPart = adjAfter * (DIM_WEIGHTS.expand || 1)
          const barrierPart = (boundaryBefore - adjAfter) * (DIM_WEIGHTS.barrier || 0.7)
          score += expandPart * (REGION_CLASS_WEIGHTS.boundary || 0.8)
          score += barrierPart * (REGION_CLASS_WEIGHTS.boundary || 0.8)
        }
        if (ENABLE_LOOKAHEAD){
          const tmp = curColors.slice();
          for(const id of regionSet) tmp[idToIndex.get(id)] = c
          const lb1 = ENABLE_LB ? lowerBound(tmp) : 0
          score += (prevLB - lb1) * 4 - lb1 * 1
        }
        if (FLAGS.enableLookaheadDepth2){
          const tmp = curColors.slice();
          for(const id of regionSet) tmp[idToIndex.get(id)] = c
          const lb1 = ENABLE_LB ? lowerBound(tmp) : 0
          const q=[...regionSet]; const visited2=new Set([...regionSet]); const newRegionTmp=new Set([...regionSet])
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===c){ visited2.add(nb); newRegionTmp.add(nb); q.push(nb) } } }
          const adj2=new Set(); const gain2=new Map()
          for(const tid of newRegionTmp){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=tmp[nidx]; if(cc!==c && cc && cc!=='transparent' && !tri.deleted){ adj2.add(cc); gain2.set(cc,(gain2.get(cc)||0)+1) } } }
          const raw2 = adj2.size>0 ? [...adj2] : palette
          const preK2 = 4
          const prelim2 = raw2.map(c2=>({ c2, g:(gain2.get(c2)||0), f:(colorCount.get(c2)||0) }))
            .map(({c2,g,f})=>({ c2, score0: g*3 + f*0.5 }))
            .sort((a,b)=>b.score0-a.score0)
            .slice(0, preK2)
          let bestLb2 = lb1
          for(const {c2} of prelim2){ const tmp2 = tmp.slice(); for(const id of newRegionTmp) tmp2[idToIndex.get(id)] = c2; const lb2 = ENABLE_LB ? lowerBound(tmp2) : 0; if(lb2 < bestLb2) bestLb2 = lb2 }
          score += (prevLB - lb1) * 3 + (lb1 - bestLb2) * 2
        }
        return { c, score }
      })
      .sort((a,b)=> b.score - a.score)
      .slice(0, limitTry)
      .map(x=>x.c)
    for(const color of tryColors){
      if(color===regionColor) continue
      const nextColors = curColors.slice()
      for(const id of regionSet) nextColors[idToIndex.get(id)] = color
      const key = keyFromColors(nextColors)
      if(seen.has(key)) continue
      seen.add(key)
      const newRegion = new Set([...regionSet])
      const q=[...regionSet]
      const visited2 = new Set([...regionSet])
      while(q.length){
        const tid=q.shift()
        const idx=idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx=idToIndex.get(nb)
          const tri = triangles[nidx]
          if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){
            visited2.add(nb); newRegion.add(nb); q.push(nb)
          }
        }
      }
      const nextSteps = [...cur.steps, color]
      if (nextSteps.length > maxDepth) maxDepth = nextSteps.length
        if (nextSteps.length <= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
          // 过滤：零扩张候选（应用颜色后区域未增长）
          const delta = newRegion.size - regionSet.size
          if (ENABLE_ZERO_FILTER && delta <= 0) { perf.filteredZero++; continue }
          // 准零扩张：相对增长过小则跳过（避免“几乎没用”的动作）
          const deltaRatio = delta / Math.max(1, regionSet.size)
          if (deltaRatio < MIN_DELTA_RATIO) { continue }
          // 稀有颜色过滤：全局出现很少且桥接价值不显著时跳过（使用邻接后种类数作为桥接代理）
          const freq = (colorCount.get(color) || 0)
          const rareTh = Math.max(RARE_FREQ_ABS, Math.floor(triangles.length * RARE_FREQ_RATIO))
          if (freq < rareTh) {
            const adjAfter = computeAdjAfterSize(color, nextColors, newRegion)
            if (adjAfter < RARE_ALLOW_BRIDGE_MIN) { continue }
          }
          // 构建下一状态的边界邻居缓存（可选）
          let nextBoundaryNeighbors
          if (ENABLE_INCREMENTAL) {
            const boundarySet = new Set()
            for (const tid2 of newRegion) {
              const idx2 = idToIndex.get(tid2)
              for (const nb2 of neighbors[idx2]) {
                const nidx2 = idToIndex.get(nb2)
                if (nidx2 == null) continue
                const tri2 = triangles[nidx2]
                const c2 = nextColors[nidx2]
                if (c2!==color && c2 && c2!=='transparent' && !tri2.deleted) {
                  boundarySet.add(nb2)
                }
              }
            }
            nextBoundaryNeighbors = Array.from(boundarySet)
          }
          let baseScore = (gain.get(color)||0)*3 + (colorCount.get(color)||0)*0.5 + (enlargePotential.get(color)||0)*2
          if (ENABLE_BRIDGE_FIRST){
            const adjAfter = computeAdjAfterSize(color, nextColors, newRegion)
            baseScore += adjAfter * ADJ_AFTER_WEIGHT
          }
          const childLB = ENABLE_LB ? lowerBound(nextColors) : 0
          // 下界改进不足：若一步后下界几乎不降，则跳过（局部计算当前下界）
          if (ENABLE_LB) {
            const prevLBLocal = lowerBound(curColors)
            if ((prevLBLocal - childLB) < LB_IMPROVE_MIN) { continue }
          }
          const priority = baseScore - childLB * 2
          queueStates.push({ colors: nextColors, region: newRegion, steps: nextSteps, boundaryNeighbors: nextBoundaryNeighbors, priority })
          perf.enqueued++
          perf.expanded += Math.max(0, delta)
        }
    }
    if (ENABLE_BEST_FIRST) {
      queueStates.sort((a,b)=> (b.priority ?? -Infinity) - (a.priority ?? -Infinity))
    }
  }
  if(solutions.length===0){
    // 若设置了步数上限，使用深度受限 DFS 回退以保证统一解（在上限内）
    if (Number.isFinite(stepLimit)) {
      const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
      const neighbors = triangles.map(t=>t.neighbors)
      const seen = new Set([keyFromColors(startColors)])
      const buildRegion = (colors) => {
        const rc = colors[idToIndex.get(startId)]
        const rs = new Set(); const q=[startId]; const v=new Set([startId])
        while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
        return rs
      }
      const orderColors = (colors, regionSet) => {
        const rc = colors[idToIndex.get(startId)]
        const adjColors = new Set(); const gain=new Map()
        for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const c=colors[nidx]; if(c!==rc && c && c!=='transparent' && !tri.deleted){ adjColors.add(c); gain.set(c,(gain.get(c)||0)+1) } } }
        const colorCount=new Map(); for(const t of triangles){ if(!t.deleted && t.color && t.color!=='transparent'){ colorCount.set(t.color,(colorCount.get(t.color)||0)+1) } }
        const raw = adjColors.size>0 ? [...adjColors] : palette
        const score=(c)=>{
          let s = (gain.get(c)||0)*3 + (colorCount.get(c)||0)*0.5
          if (ENABLE_BRIDGE_FIRST){ s += computeAdjAfterSize(c, colors, regionSet) * ADJ_AFTER_WEIGHT }
          return s
        }
        return raw.sort((a,b)=>score(b)-score(a)).slice(0,8).filter(c=>c!==rc)
      }
      const startTs = Date.now()
      async function dfs(colors, regionSet, steps){
        if(isUniformSimple(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))) return steps
        if(steps.length>=stepLimit) return null
        if(Date.now()-startTs > TIME_BUDGET_MS) return null
        const tryColors = orderColors(colors, regionSet)
        for(const color of tryColors){
          const nextColors = colors.slice(); for(const id of regionSet) nextColors[idToIndex.get(id)] = color
          const key = keyFromColors(nextColors); if(seen.has(key)) continue; seen.add(key)
          const q=[...regionSet]; const visited2=new Set([...regionSet]); const newRegion=new Set([...regionSet])
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2.add(nb); newRegion.add(nb); q.push(nb) } } }
          const res = await dfs(nextColors, newRegion, [...steps,color]); if(res) return res
          await new Promise(r=>setTimeout(r,0))
        }
        return null
      }
      const dfsRegion = buildRegion(startColors)
      const dfsRes = await dfs(startColors, dfsRegion, [])
      if(dfsRes) return { paths: [dfsRes], minSteps: dfsRes.length, timedOut }
    }
    // 否则：保留贪心近似路径用于无限上限场景
    const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
    const neighbors = triangles.map(t=>t.neighbors)
    let colors = startColors.slice()
    const steps=[]
    let safeGuard=0
    const limit = Number.isFinite(stepLimit) ? stepLimit : 80
    while(!isUniformSimple(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]}))) && safeGuard<limit){
      const regionSet = new Set(); const q=[startId]; const visited=new Set([startId])
      const regionColor = colors[idToIndex.get(startId)]
      while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==regionColor) continue; regionSet.add(id); for(const nb of neighbors[idx]){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } } }
      const gain=new Map(); for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri = triangles[nidx]; const c = colors[nidx]; if(c!==regionColor && c && c!=='transparent' && !tri.deleted){ gain.set(c, (gain.get(c)||0)+1) } } }
      const nextColor = [...gain.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] || (palette.find(c=>c!==regionColor) ?? palette[0])
      if(!nextColor || nextColor===regionColor) break
      for(const id of regionSet){ colors[idToIndex.get(id)] = nextColor }
      steps.push(nextColor); safeGuard++
      await new Promise(r=>setTimeout(r,0))
    }
    return { paths: steps.length? [steps] : [], minSteps: steps.length, timedOut }
  }
  const minSteps = solutions[0].length
  const paths = solutions.filter(s=>s.length===minSteps).slice(0, maxBranches)
  if (LOG_PERF) {
    try { console.log('[SolverWorker] Perf', { nodes, enqueued: perf.enqueued, expanded: perf.expanded, filteredZero: perf.filteredZero, elapsedMs: Date.now() - startTime }) } catch {}
  }
  return { paths, minSteps, timedOut }
}

async function Solver_minStepsAuto(triangles, palette, maxBranches=3, onProgress, stepLimit=Infinity){
  const startTime = Date.now()
  // 计算时限：可通过 SOLVER_FLAGS.workerTimeBudgetMs 配置（默认 300000 ms）
  const TIME_BUDGET_MS = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.workerTimeBudgetMs))
    ? Math.max(1000, self.SOLVER_FLAGS.workerTimeBudgetMs)
    : 300000
  let timedOut = false
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  const PROG_COMP_INTERVAL = Number.isFinite(FLAGS?.progressComponentsIntervalMs) ? Math.max(0, FLAGS.progressComponentsIntervalMs) : 100
  const USE_DFS_FIRST = !!FLAGS.useDFSFirst
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  const visited = new Set()
  const components = []
  let compLastTs = startTime
  for(const t of triangles){
    const id = t.id
    if(visited.has(id)) continue
    if(t.deleted || t.color==='transparent') continue
    const color = t.color
    const comp=[]
    const q=[id]
    visited.add(id)
    while(q.length){
      const cid=q.shift()
      const idx=idToIndex.get(cid)
      const tri=triangles[idx]
      if(tri.deleted || tri.color==='transparent' || tri.color!==color) continue
      comp.push(cid)
      for(const nb of neighbors[idx]){ if(!visited.has(nb)){ const nidx=idToIndex.get(nb); const tri2=triangles[nidx]; if(!tri2.deleted && tri2.color!=='transparent' && tri2.color===color){ visited.add(nb); q.push(nb) } } }
    }
    if(comp.length>0){
      components.push({ color, ids: comp, startId: comp[0], size: comp.length })
      const nowTs = Date.now()
      // 更频繁的组件阶段进度：每个组件打点，并附带 elapsedMs；可选时间节流
      if (onProgress) {
        if (PROG_COMP_INTERVAL <= 0 || (nowTs - compLastTs) >= PROG_COMP_INTERVAL) {
          compLastTs = nowTs
          onProgress({ phase:'components', count: components.length, elapsedMs: nowTs - startTime })
        } else {
          onProgress({ phase:'components', count: components.length, elapsedMs: nowTs - startTime })
        }
      }
    }
  }
  if(components.length===0) return { bestStartId: null, paths: [], minSteps: 0 }
  components.sort((a,b)=>b.size-a.size)
  let best={ startId:null, minSteps: Infinity, paths: [] }
  for(const comp of components){
    if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break }
    await new Promise(r=>setTimeout(r,0))
    // 若启用 DFS-first，先用深度受限 DFS 找到任意可行解并立刻返回
    if (USE_DFS_FIRST && Number.isFinite(stepLimit)) {
      const resDFS = await (async function(){
        const startColors = triangles.map(t=>t.color)
        const seen = new Set([keyFromColors(startColors)])
        const startIdLocal = comp.startId
        const buildRegion = (colors) => {
          const rc = colors[idToIndex.get(startIdLocal)]
          const rs = new Set(); const q=[startIdLocal]; const v=new Set([startIdLocal])
          while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
          return rs
        }
        const orderColors = (colors, regionSet) => {
          const rc = colors[idToIndex.get(startIdLocal)]
          const adjColors = new Set(); const gain=new Map()
          for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const c=colors[nidx]; if(c!==rc && c && c!=='transparent' && !tri.deleted){ adjColors.add(c); gain.set(c,(gain.get(c)||0)+1) } } }
          const colorCount=new Map(); for(const t of triangles){ if(!t.deleted && t.color && t.color!=='transparent'){ colorCount.set(t.color,(colorCount.get(t.color)||0)+1) } }
          const raw = adjColors.size>0 ? [...adjColors] : palette
          const score=(c)=>{ let s=(gain.get(c)||0)*3 + (colorCount.get(c)||0)*0.5; return s }
          return raw.sort((a,b)=>score(b)-score(a)).slice(0,8).filter(c=>c!==rc)
        }
        const startTs = Date.now()
        async function dfs(colors, regionSet, steps){
          if(isUniformSimple(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))) return steps
          if(steps.length>=stepLimit) return null
          if(Date.now()-startTs > TIME_BUDGET_MS) return null
          const tryColors = orderColors(colors, regionSet)
          for(const color of tryColors){
            const nextColors = colors.slice(); for(const id of regionSet) nextColors[idToIndex.get(id)] = color
            const key = keyFromColors(nextColors); if(seen.has(key)) continue; seen.add(key)
            const q=[...regionSet]; const visited2=new Set([...regionSet]); const newRegion=new Set([...regionSet])
            while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2.add(nb); newRegion.add(nb); q.push(nb) } }
            }
            const res = await dfs(nextColors, newRegion, [...steps,color]); if(res) return res
            await new Promise(r=>setTimeout(r,0))
          }
          return null
        }
        const dfsRegion = buildRegion(startColors)
        const dfsRes = await dfs(startColors, dfsRegion, [])
        if(dfsRes){ onProgress?.({ phase:'solution', minSteps: dfsRes.length, solutions: 1, elapsedMs: Date.now() - startTime }); return { paths:[dfsRes], minSteps: dfsRes.length, timedOut } }
        return null
      })()
      if (resDFS && resDFS.paths && resDFS.paths.length>0) {
        return { bestStartId: comp.startId, paths: resDFS.paths, minSteps: resDFS.minSteps, timedOut }
      }
    }
    const res = await Solver_minSteps(triangles, comp.startId, palette, maxBranches, (p)=>{
      onProgress?.({ phase:'subsearch', startId: comp.startId, ...p })
    }, stepLimit)
    if(res && res.paths && res.paths.length>0){
      if(res.minSteps < best.minSteps){ best = { startId: comp.startId, minSteps: res.minSteps, paths: res.paths }; onProgress?.({ phase:'best_update', bestStartId: best.startId, minSteps: best.minSteps }) }
      if (Number.isFinite(stepLimit) && res.minSteps <= stepLimit) {
        break
      }
      if (res.timedOut) timedOut = true
    }
  }
  if(best.minSteps===Infinity) return { bestStartId: null, paths: [], minSteps: 0, timedOut }
  return { bestStartId: best.startId, paths: best.paths, minSteps: best.minSteps, timedOut }
}

// 方案后处理优化：对已统一颜色的路径进行反思、拆解与压缩
async function OptimizeSolution(triangles, palette, startId, path, onProgress){
  const startTime = Date.now()
  const TIME_BUDGET_MS = 120000
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  // 早停：路径超过50，直接跳过优化，仅返回关键信息
  if (Array.isArray(path) && path.length > 50) {
    onProgress?.({ phase:'optimize_skipped', reason:'path_too_long', length: path.length })
    return { bestStartId: startId, optimizedPath: path, originalLen: path.length, optimizedLen: path.length, shortened: false, analysis: { ok:true, skipped:true, reason:'path_too_long' } }
  }
  let colors = triangles.map(t=>t.color)
  // 快速统一性判定（颜色数组，提前退出）
  const isUniformFast = (colorsArr)=>{
    let first=null
    for(let i=0;i<triangles.length;i++){
      const t=triangles[i]; const c=colorsArr[i]
      if(t.deleted || !c || c==='transparent') continue
      if(first===null) { first=c } else if (c!==first) { return false }
    }
    return first!==null
  }
  const buildRegion = (colorsLocal, startIdLocal) => {
    const rc = colorsLocal[idToIndex.get(startIdLocal)]
    const rs = new Set(); const q=[startIdLocal]; const v=new Set([startIdLocal])
    while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colorsLocal[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
    return rs
  }
  const isUniformNow = ()=> isUniformSimple(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))
  // 若当前路径不统一，则直接返回原路径
  let tmpColors = colors.slice()
  for(const stepColor of path){
    const region = buildRegion(tmpColors, startId)
    for(const id of region){ tmpColors[idToIndex.get(id)] = stepColor }
  }
  if(!isUniformFast(tmpColors)){
    onProgress?.({ phase:'analysis', ok:false, reason:'path_not_unified' })
    return { bestStartId: startId, optimizedPath: path, originalLen: path.length, optimizedLen: path.length, shortened: false, analysis: { ok:false } }
  }
  // 计算每一步的增益，识别关键节点
  const gains=[]
  let simColors = colors.slice()
  for(const color of path){
    const region = buildRegion(simColors, startId)
    const before = region.size
    // 应用颜色并扩张新区域
    const next = simColors.slice(); for(const id of region) next[idToIndex.get(id)] = color
    const q=[...region]; const visited2=new Set([...region]); const newRegion=new Set([...region])
    while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && next[nidx]===color){ visited2.add(nb); newRegion.add(nb); q.push(nb) } }
    }
    const after = newRegion.size
    gains.push(Math.max(0, after - before))
    simColors = next
  }
  const sorted = [...gains].sort((a,b)=>b-a)
  const q30 = sorted[Math.min(sorted.length-1, Math.floor(sorted.length*0.3))] ?? 0
  const mean = gains.reduce((s,x)=>s+x,0)/(gains.length||1)
  const varv = gains.reduce((s,x)=>s+(x-mean)*(x-mean),0)/(gains.length||1)
  const std = Math.sqrt(varv)
  const critical = gains.map((g,i)=> ({i,g,critical: (g>=q30) || (g>=mean+std)})).filter(x=>x.critical)
  onProgress?.({ phase:'analysis', ok:true, len: path.length, criticalCount: critical.length, topGains: sorted.slice(0,5), mean, std })
  // 分组重排与压缩（桥接/边界/丰富）
  const boundaryDistinctLocal = (colors0, region0)=>{
    const rc = colors0[idToIndex.get(startId)]
    const set = new Set()
    for(const tid of region0){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const c=colors0[nidx]; if(c!==rc && c && c!=='transparent' && !tri.deleted){ set.add(c) } } }
    return set.size
  }
  const classifyStep = (curColors, region, color)=>{
    const tmp = curColors.slice(); for(const id of region) tmp[idToIndex.get(id)] = color
    const q=[...region]; const v=new Set([...region]); const newRegion=new Set([...region])
    while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!v.has(nb) && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===color){ v.add(nb); newRegion.add(nb); q.push(nb) } } }
    const bdBefore = boundaryDistinctLocal(curColors, region)
    const bdAfter = boundaryDistinctLocal(tmp, region)
    const barrierDelta = Math.max(0, bdBefore - bdAfter)
    let connectScore = 0
    try {
      const rag = (typeof buildRAG==='function') ? buildRAG(triangles) : null
      if (rag){
        const seenComps = new Set()
        for(const tid of newRegion){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const cj = rag.triToComp ? rag.triToComp[nidx] : null; if(cj!=null){ seenComps.add(cj) } } }
        connectScore = seenComps.size
      }
    } catch {}
    if (connectScore >= Math.max(1, barrierDelta)) return 'bridge'
    if (barrierDelta > 0) return 'boundary'
    return 'richness'
  }
  let curColors2 = colors.slice(); const tags=[]
  for(const color of path){ const region = buildRegion(curColors2, startId); const tag = classifyStep(curColors2, region, color); tags.push(tag); for(const id of region){ curColors2[idToIndex.get(id)] = color } }
  const bridgeSteps = []; const boundarySteps=[]; const richnessSteps=[]
  for(let i=0;i<path.length;i++){ const c=path[i]; const tag=tags[i]; if(tag==='bridge') bridgeSteps.push(c); else if(tag==='boundary') boundarySteps.push(c); else richnessSteps.push(c) }
  let candidate = [...bridgeSteps, ...boundarySteps, ...richnessSteps]
  const compressed = []
  for(const c of candidate){ if(compressed.length===0 || compressed[compressed.length-1]!==c) compressed.push(c) }
  candidate = compressed.filter((c, i)=> gains[i]>0 )
  let testColors = triangles.map(t=>t.color)
  for(const c of candidate){ const reg = buildRegion(testColors, startId); for(const id of reg){ testColors[idToIndex.get(id)] = c } }
  if(isUniformFast(testColors) && candidate.length <= path.length){ path = candidate }
  // 局部窗口重排（关注高权重与高连通潜力）
  const OPT_WINDOW_SIZE = Number.isFinite(self.SOLVER_FLAGS?.optimizeWindowSize) ? self.SOLVER_FLAGS.optimizeWindowSize : 5
  const OPT_ENABLE_WINDOW = self.SOLVER_FLAGS?.optimizeEnableWindow !== false
  if (OPT_ENABLE_WINDOW && OPT_WINDOW_SIZE>1){
    const reorderWithinWindow = (p)=>{
      let curColors = triangles.map(t=>t.color)
      const metrics=[]
      for(const color of p){
        const region = buildRegion(curColors, startId)
        const rc = curColors[idToIndex.get(startId)]
        const adjSet=new Set(); for(const tid of region){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const cc=curColors[nidx]; if(cc!==rc && cc && cc!=='transparent'){ adjSet.add(cc) } } }
        const beforeAdj = adjSet.size
        const tmp=curColors.slice(); for(const id of region){ tmp[idToIndex.get(id)] = color }
        const reg2=new Set([...region])
        const q=[...region]
        const visited = new Uint8Array(triangles.length)
        for(const id of region){ const idx=idToIndex.get(id); if(idx!=null) visited[idx]=1 }
        while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited[nidx] && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===color){ visited[nidx]=1; reg2.add(nb); q.push(nb) } } }
        const adjSet2=new Set(); for(const tid of reg2){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const cc=tmp[nidx]; if(cc!==color && cc && cc!=='transparent'){ adjSet2.add(cc) } } }
        const afterAdj = adjSet2.size
        const barrierDelta = Math.max(0, beforeAdj - afterAdj)
        const expandAdj = afterAdj
        // 计算窗口内“saddle”潜力（边界上颜色 color 的分量前两大之和）
        const seeds=[]; for(const tid of reg2){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(tmp[nidx]===color && !reg2.has(nb)) seeds.push(nb) } }
        const visitedW = new Set(); const compSizesW=[]
        for(const s of seeds){ if(visitedW.has(s)) continue; let size=0; const q2=[s]; visitedW.add(s); while(q2.length){ const u=q2.shift(); size++; const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx==null) continue; if(!visitedW.has(v) && tmp[vIdx]===color){ visitedW.add(v); q2.push(v) } } } compSizesW.push(size) }
        compSizesW.sort((a,b)=>b-a)
        const saddleScore = (compSizesW[0]||0) + (compSizesW[1]||0)
        const tag = barrierDelta>0 ? 'boundary' : (afterAdj>beforeAdj ? 'bridge' : 'richness')
        const priority = ((self.SOLVER_FLAGS?.regionClassWeights?.[tag])||1) * (((self.SOLVER_FLAGS?.dimensionWeights?.expand)||1)*expandAdj + ((self.SOLVER_FLAGS?.dimensionWeights?.barrier)||0.7)*barrierDelta) + ((self.SOLVER_FLAGS?.regionClassWeights?.saddle)||1.2) * (((self.SOLVER_FLAGS?.dimensionWeights?.multiFront)||2.0) * saddleScore)
        metrics.push({ color, priority })
        for(const id of region){ curColors[idToIndex.get(id)] = color }
      }
      const out=[]
      for(let i=0;i<p.length;i+=OPT_WINDOW_SIZE){
        const seg = metrics.slice(i, i+OPT_WINDOW_SIZE)
        const sortedSeg = seg.slice().sort((a,b)=> b.priority - a.priority)
        out.push(...sortedSeg.map(x=>x.color))
      }
      let testColors2 = triangles.map(t=>t.color)
      for(const c of out){ const reg = buildRegion(testColors2, startId); for(const id of reg){ testColors2[idToIndex.get(id)] = c } }
      return isUniformFast(testColors2) ? out : p
    }
    const newPath = reorderWithinWindow(path)
    if(newPath.length === path.length) path = newPath
  }
  // 反思压缩：尝试移除低优先步骤（仍能统一颜色）
  const OPT_ENABLE_REMOVAL = self.SOLVER_FLAGS?.optimizeEnableRemoval !== false
  if (OPT_ENABLE_REMOVAL){
    const SNAP_K = 3
    const buildSnapshots = (p)=>{ const snaps=[]; let cc=triangles.map(t=>t.color); for(let i=0;i<p.length;i++){ const reg=buildRegion(cc,startId); for(const id of reg){ cc[idToIndex.get(id)] = p[i] } if((i+1)%SNAP_K===0) snaps.push({ step:i+1, colors: cc.slice() }) } return { snaps } }
    let changed = true; let attempts=0
    const maxAttempts = Math.min(12, Math.ceil(path.length/6))
    while(changed && attempts<maxAttempts){
      changed=false; attempts++
      const { snaps } = buildSnapshots(path)
      const meanGain = gains.reduce((s,x)=>s+x,0)/(gains.length||1)
      for(let i=0;i<path.length;i++){
        const candidate2 = path.slice(0,i).concat(path.slice(i+1))
        if (i<gains.length && gains[i] >= meanGain) continue
        let colorsTest = triangles.map(t=>t.color)
        const snapIdx = Math.max(0, Math.floor(i/SNAP_K)-1)
        if (snaps[snapIdx]) colorsTest = snaps[snapIdx].colors.slice()
        const startJ = snaps[snapIdx] ? snaps[snapIdx].step : 0
        for(let j=startJ;j<candidate2.length;j++){ const reg = buildRegion(colorsTest, startId); for(const id of reg){ colorsTest[idToIndex.get(id)] = candidate2[j] } }
        if(isUniformFast(colorsTest)){ path = candidate2; changed=true; break }
      }
    }
  }
  // 下界引导的修剪（优先移除不降低下界且增益偏低的步骤）
  const OPT_ENABLE_BOUND_TRIM = self.SOLVER_FLAGS?.optimizeEnableBoundTrim !== false
  if (OPT_ENABLE_BOUND_TRIM){
    const lowerBoundLocal = (colorsLocal)=>{
      const s = new Set();
      for(let i=0;i<triangles.length;i++){ const t=triangles[i]; const c=colorsLocal[i]; if(!t.deleted && c && c!=='transparent') s.add(c) }
      return Math.max(0, s.size - 1)
    }
    let curColorsBT = triangles.map(t=>t.color)
    const lbBeforeEach=[]; const lbAfterEach=[]
    for(const color of path){
      const lb0 = lowerBoundLocal(curColorsBT)
      const region = buildRegion(curColorsBT, startId)
      const next = curColorsBT.slice(); for(const id of region){ next[idToIndex.get(id)] = color }
      const lb1 = lowerBoundLocal(next)
      lbBeforeEach.push(lb0); lbAfterEach.push(lb1); curColorsBT = next
    }
    const meanGain = gains.reduce((s,x)=>s+x,0)/(gains.length||1)
    for(let i=0;i<path.length;i++){
      if(lbAfterEach[i] >= lbBeforeEach[i] && gains[i] < meanGain){
        const tryPath = path.slice(0,i).concat(path.slice(i+1))
        let testColors3 = triangles.map(t=>t.color)
        for(const c of tryPath){ const reg = buildRegion(testColors3, startId); for(const id of reg){ testColors3[idToIndex.get(id)] = c } }
        if(isUniformFast(testColors3)){ path = tryPath; break }
      }
    }
  }
  // 相邻交换的爬山（最多两轮）：若交换后更快降低下界或更易压缩则采用
  const OPT_ENABLE_SWAP = self.SOLVER_FLAGS?.optimizeEnableSwap !== false
  let OPT_SWAP_PASSES = Number.isFinite(self.SOLVER_FLAGS?.optimizeSwapPasses) ? self.SOLVER_FLAGS.optimizeSwapPasses : 1
  if (path.length>80) OPT_SWAP_PASSES = Math.max(1, Math.min(OPT_SWAP_PASSES, 1))
  if (OPT_ENABLE_SWAP && path.length>1){
    const compressAdj = (arr)=>{ const out=[]; for(const c of arr){ if(out.length===0 || out[out.length-1]!==c) out.push(c) } return out }
    const lbLocal = (colorsLocal)=>{ const s=new Set(); for(let i=0;i<triangles.length;i++){ const t=triangles[i]; const c=colorsLocal[i]; if(!t.deleted && c && c!=='transparent') s.add(c) } return Math.max(0, s.size - 1) }
    const lbAfterFirst = (p)=>{ let cc = triangles.map(t=>t.color); const region = buildRegion(cc, startId); const next = cc.slice(); for(const id of region){ next[idToIndex.get(id)] = p[0] } return lbLocal(next) }
    for(let pass=0; pass<OPT_SWAP_PASSES; pass++){
      let improved=false
      for(let i=0;i<path.length-1;i++){
        const tryPath = path.slice(0,i).concat([path[i+1], path[i]], path.slice(i+2))
        let ccTest = triangles.map(t=>t.color)
        for(const c of tryPath){ const reg = buildRegion(ccTest, startId); for(const id of reg){ ccTest[idToIndex.get(id)] = c } }
        if(!isUniformFast(ccTest)) continue
        const lbOrig = lbAfterFirst(path.slice(i))
        const lbSwap = lbAfterFirst(tryPath.slice(i))
        const lenOrig = compressAdj(path).length
        const lenSwap = compressAdj(tryPath).length
        if (lbSwap < lbOrig || lenSwap < lenOrig){ path = tryPath; improved=true }
      }
      if(!improved) break
    }
  }
  // 尝试全局缩短：在上限为原路径-1的条件下重新求解
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  const prevUseDFS = FLAGS.useDFSFirst
  const prevReturn = FLAGS.returnFirstFeasible
  try { self.SOLVER_FLAGS = { ...FLAGS, useDFSFirst: true, returnFirstFeasible: true } } catch {}
  const res = await Solver_minStepsAuto(triangles, palette, 3, (p)=>{ onProgress?.({ ...p, phase: p?.phase || 'optimize_search' }) }, Math.max(0, path.length-1))
  try { self.SOLVER_FLAGS = { ...self.SOLVER_FLAGS, useDFSFirst: prevUseDFS, returnFirstFeasible: prevReturn } } catch {}
  if(res && res.paths && res.paths.length>0 && res.minSteps < path.length){
    onProgress?.({ phase:'optimized', improved: true, minSteps: res.minSteps })
    return { bestStartId: res.bestStartId ?? startId, optimizedPath: res.paths[0], originalLen: path.length, optimizedLen: res.minSteps, shortened: true, analysis: { ok:true, critical } }
  } else {
    onProgress?.({ phase:'optimized', improved: false })
    return { bestStartId: startId, optimizedPath: path, originalLen: path.length, optimizedLen: path.length, shortened: false, analysis: { ok:true, critical } }
  }
}

self.onmessage = async (e) => {
  const { type, triangles, palette, maxBranches, stepLimit, ragOptions, flags } = e.data || {}
  // 支持在运行前设置或更新 flags（从主线程传入）
  if (type === 'set_flags') {
    try { self.SOLVER_FLAGS = { ...(self.SOLVER_FLAGS||{}), ...(flags||{}) } } catch {}
    self.postMessage({ type:'flags_set', payload: { ok: true } })
    return
  }
  if(type==='auto'){
    const result = await Solver_minStepsAuto(triangles, palette, maxBranches, (p)=>{
      self.postMessage({ type:'progress', payload: p })
    }, stepLimit)
    // 保持向后兼容：仅在存在 ragOptions 时，附带回传，便于调试
    const payload = ragOptions ? { ...result, ragPlan: { enabled: !!ragOptions?.enable } } : result
    self.postMessage({ type:'result', payload })
  } else if(type==='optimize'){
    const { startId, path } = e.data || {}
    const result = await OptimizeSolution(triangles, palette, startId, path, (p)=>{
      self.postMessage({ type:'progress', payload: p })
    })
    self.postMessage({ type:'result', payload: result })
  }
}