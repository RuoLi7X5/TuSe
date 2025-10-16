import { buildRAG, colorFrequency } from './grid-utils'
import { getHeuristic } from './heuristics'
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
  const BRIDGE_WEIGHT = Number.isFinite(FLAGS?.bridgeWeight) ? FLAGS.bridgeWeight : 1.0
  const GATE_WEIGHT = Number.isFinite(FLAGS?.gateWeight) ? FLAGS.gateWeight : 0.4
  const RICHNESS_WEIGHT = Number.isFinite(FLAGS?.richnessWeight) ? FLAGS.richnessWeight : 0.5
  const BOUNDARY_WEIGHT = Number.isFinite(FLAGS?.boundaryWeight) ? FLAGS.boundaryWeight : 0.8
  const REGION_CLASS_WEIGHTS = FLAGS?.regionClassWeights || { boundary: 0.8, bridge: 1.0, richness: 0.6 }
  const DIM_WEIGHTS = FLAGS?.dimensionWeights || { expand: 1.0, connect: 0.8, barrier: 0.7 }
  const USE_STRICT_LB_BF = !!FLAGS.strictMode || !!FLAGS.useStrongLBInBestFirst
  // 新增开关：零扩张候选过滤与性能日志
  const ENABLE_ZERO_FILTER = (FLAGS.enableZeroExpandFilter !== false)
  const LOG_PERF = !!FLAGS.logPerf
  // 新增：DFS 进度上报时间间隔（毫秒），0 表示禁用
  const PROGRESS_DFS_INTERVAL_MS = Number.isFinite(FLAGS?.progressDFSIntervalMs) ? Math.max(0, FLAGS.progressDFSIntervalMs) : 50
  // 稀有颜色与“准零扩张”/下界改进的过滤阈值（可调）
  const RARE_FREQ_RATIO = Number.isFinite(FLAGS?.rareFreqRatio) ? FLAGS.rareFreqRatio : 0.03
  const RARE_FREQ_ABS = Number.isFinite(FLAGS?.rareFreqAbs) ? FLAGS.rareFreqAbs : 3
  const RARE_ALLOW_BRIDGE_MIN = Number.isFinite(FLAGS?.rareAllowBridgeMin) ? FLAGS.rareAllowBridgeMin : 2.0
  const RARE_ALLOW_GATE_MIN = Number.isFinite(FLAGS?.rareAllowGateMin) ? FLAGS.rareAllowGateMin : 1.0
  const MIN_DELTA_RATIO = Number.isFinite(FLAGS?.minDeltaRatio) ? FLAGS.minDeltaRatio : 0.02
  const LB_IMPROVE_MIN = Number.isFinite(FLAGS?.lbImproveMin) ? FLAGS.lbImproveMin : 1
  // 新增：质量采样与增益下降告警阈值（可通过 FLAGS 配置）
  const QUALITY_SAMPLE_RATE = Number.isFinite(FLAGS?.qualitySampleRate) ? FLAGS.qualitySampleRate : 0.15
  const GAIN_DROP_WARN_RATIO = Number.isFinite(FLAGS?.gainDropWarnRatio) ? FLAGS.gainDropWarnRatio : 0.01

  function computeAdjAfterSize(color, curColors, regionSet){
    // 预演一步应用 color 后的新区域相邻颜色种类数（轻量版，无 RAG 依赖）
    const tmp = curColors.slice()
    for(const id of regionSet){ tmp[idToIndex.get(id)] = color }
    const newRegion = new Set([...regionSet])
    const q=[...regionSet]
    const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
    while(q.length){
      const tid=q.shift(); const idx=idToIndex.get(tid)
      for(const nb of neighbors[idx]){
        const nidx=idToIndex.get(nb); if(nidx==null) continue
        const tri=triangles[nidx]; const cc=tmp[nidx]
        if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && cc===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) }
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
  function lowerBoundStrictLocal(colors, regionSet){
    let activeCount = 0
    const colorFreq = new Map()
    for(let i=0;i<triangles.length;i++){
      const t=triangles[i]; const c=colors[i]
      if(!t.deleted && c && c!=='transparent'){
        activeCount++
        colorFreq.set(c, (colorFreq.get(c)||0)+1)
      }
    }
    const lbColors = Math.max(0, colorFreq.size - 1)
    const rc = colors[idToIndex.get(startId)]
    const frontier = new Set()
    for(const tid of regionSet){
      const idx=idToIndex.get(tid)
      for(const nb of neighbors[idx]){
        const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]
        if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ frontier.add(cc) }
      }
    }
    const lbFrontier = frontier.size
    const remaining = Math.max(0, activeCount - (regionSet?.size||0))
    let maxColorCount = 0
    for(const v of colorFreq.values()){ if(v>maxColorCount) maxColorCount=v }
    const lbArea = maxColorCount>0 ? Math.ceil(remaining / maxColorCount) : 0
    return Math.max(lbColors, lbFrontier, lbArea)
  }

  // RAG 构建与颜色频次（一次性，供桥/门评分使用）
  const RAG = (typeof buildRAG === 'function') ? buildRAG(triangles) : null
  const FREQ = (typeof colorFrequency === 'function') ? colorFrequency(triangles) : new Map()
  const COLOR_COMP_COUNT = new Map()
  if (RAG && Array.isArray(RAG.components)) {
    for (const comp of RAG.components) {
      const c = comp.color; if (c) COLOR_COMP_COUNT.set(c, (COLOR_COMP_COUNT.get(c)||0)+1)
    }
  }
  const getColorBiasRAG = (c)=> 1 / Math.max(1, (COLOR_COMP_COUNT.get(c)||1))

  function computeBridgePotential(color, curColors, regionSet){
    // 估计打通到高扩张性组件的潜力（使用 RAG 缓存）
    if (!RAG) return { bridgePotential: 0, gateScore: 0 }
    try{
      const tmp = curColors.slice()
      for(const id of regionSet){ tmp[idToIndex.get(id)] = color }
      // 构建一步后的新区域成员集合
      const newRegion = new Set([...regionSet])
      const q=[...regionSet]; const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
      while(q.length){
        const tid=q.shift(); const idx=idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx=idToIndex.get(nb); if(nidx==null) continue
          const tri=triangles[nidx]; const cc=tmp[nidx]
          if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && cc===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) }
        }
      }
      // 找到与新区域接触的组件集合
      const seenComps = new Set()
      const gateContacts = new Map() // compId -> contact seeds count
      for(const tid of newRegion){
        const idx=idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx=idToIndex.get(nb); if(nidx==null) continue
          const cj = RAG.triToComp[nidx]
          if(cj!=null){ seenComps.add(cj); gateContacts.set(cj, (gateContacts.get(cj)||0)+1) }
        }
      }
      let bridgePotential = 0
      let gateScore = 0
      for(const compId of seenComps){
        const comp = RAG.components[compId]; if(!comp) continue
        const bd = RAG.boundaryDegree[compId] || 0
        const adjComps = RAG.compAdj[compId] || []
        const adjColorSet = new Set()
        for(const aj of adjComps){ const co = RAG.components[aj]; if(co && co.color){ adjColorSet.add(co.color) } }
        const neighborVariety = adjColorSet.size
        const richness = bd * 0.7 + neighborVariety * 1.3
        bridgePotential += richness
        const contacts = gateContacts.get(compId) || 0
        gateScore += (bd>0 ? (bd / (contacts+1)) : 0)
      }
      return { bridgePotential: bridgePotential * RICHNESS_WEIGHT, gateScore }
    } catch { return { bridgePotential: 0, gateScore: 0 } }
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
  const perf = {
    filteredZero: 0,
    expanded: 0,
    enqueued: 0,
    lbHist: { improve0: 0, improve1_2: 0, improve3_5: 0, improve6p: 0 },
    queueMax: 0,
    depthMax: 0
  }
  while(queueStates.length && nodes<maxNodes){
    // 更高频的搜索阶段进度上报（按时间节流，而非固定节点间隔）
    if (!lastSearchReportTs) { var lastSearchReportTs = startTime }
    const nowTsSearch = Date.now()
    if (nowTsSearch - lastSearchReportTs >= PROGRESS_DFS_INTERVAL_MS) {
      lastSearchReportTs = nowTsSearch
      if (nowTsSearch - startTime > TIME_BUDGET_MS) { timedOut = true; break }
      await new Promise(r=>setTimeout(r,0))
      perf.queueMax = Math.max(perf.queueMax, queueStates.length)
      perf.depthMax = Math.max(perf.depthMax, maxDepth)
      onProgress?.({ phase: 'search', nodes, queue: queueStates.length, solutions: solutions.length, elapsedMs: nowTsSearch - startTime, maxDepth, perf })
    }
    const cur = queueStates.shift(); nodes++
    const curColors = cur.colors
    // 剪枝：超过步数上限不再扩展（并上报原因）
    if (cur.steps.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
      try {
        const lbLocal = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, cur.region) : lowerBound(curColors)) : undefined
        onProgress?.({ phase:'branch_pruned', reason:'step_limit', depth: cur.steps.length, lb: lbLocal })
      } catch {}
      continue
    }
    // LB 早停：若剩余下界超过可用步数则剪枝
    if (ENABLE_LB && Number.isFinite(stepLimit)){
      const lb = USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, cur.region) : lowerBound(curColors)
      if (cur.steps.length + lb > stepLimit) {
        try { onProgress?.({ phase:'branch_pruned', reason:'lb_exceed', depth: cur.steps.length, lb, maxAllow: stepLimit - cur.steps.length }) } catch {}
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
    // 颜色集中度偏置：按当前图的同色连通分量数量（不依赖面积）
    const compCount = new Map()
    const visitedC = new Set()
    for(const t of triangles){
      const c = t.color
      if(!c || c==='transparent' || t.deleted) continue
      if(visitedC.has(t.id)) continue
      compCount.set(c, (compCount.get(c)||0)+1)
      const q=[t.id]; visitedC.add(t.id)
      while(q.length){
        const u=q.shift(); const uIdx=idToIndex.get(u)
        for(const v of neighbors[uIdx]){
          const vIdx=idToIndex.get(v); const tv=triangles[vIdx]
          if(tv && !tv.deleted && tv.color===c && !visitedC.has(v)){ visitedC.add(v); q.push(v) }
        }
      }
    }
    const getBias = (c)=> 1 / Math.max(1, (compCount.get(c)||1))
    const tryColorsRaw = adjColors.size>0 ? [...adjColors] : palette
    const boundaryBefore = adjColors.size
    const basePreK = 6
    const depth = cur.steps.length
    const beamBase = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
    const beamDecay = Number.isFinite(FLAGS?.beamDecay) ? FLAGS.beamDecay : 0.85
    const beamMin = Number.isFinite(FLAGS?.beamMin) ? FLAGS.beamMin : 4
    const pressure = Math.min(1, (Array.isArray(queueStates) ? queueStates.length : 0) / Math.max(1, maxNodes))
    const pressureScale = ENABLE_BEAM ? Math.max(0.6, 1.0 - 0.5*pressure) : 1.0
    const dynamicWidth = ENABLE_BEAM ? Math.max(beamMin, Math.floor(beamBase * Math.pow(beamDecay, depth) * pressureScale)) : beamBase
    const preK = ENABLE_BEAM ? Math.min(dynamicWidth, basePreK) : basePreK
    const prelim = tryColorsRaw.map(c=>{
      const g = (gain.get(c)||0)
      const score0 = g*3 + getBias(c)
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
      // 非面积扩张潜力：边界同色种子数量 + 种子连通性（分量越少越好）
      const seedSet = new Set(seeds)
      const visitedB = new Set(); let compCountB = 0
      for(const s of seeds){ if(visitedB.has(s)) continue; compCountB++; const qB=[s]; visitedB.add(s); while(qB.length){ const u=qB.shift(); const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx!=null && seedSet.has(v) && !visitedB.has(v) && curColors[vIdx]===c){ visitedB.add(v); qB.push(v) } } } }
      const boundarySeedCount = seeds.length
      enlargePotential.set(c, boundarySeedCount * 1.0 + Math.max(0, boundarySeedCount - compCountB) * 0.5)
      // 双前沿saddle潜力：统计边界上颜色 c 的分量前两大之和
      const visited = new Set(); const compSizes=[]
      for(const s of seeds){ if(visited.has(s)) continue; let size=0; const q=[s]; visited.add(s); while(q.length){ const u=q.shift(); size++; const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx==null) continue; if(!visited.has(v) && curColors[vIdx]===c){ visited.add(v); q.push(v) } } } compSizes.push(size) }
      compSizes.sort((a,b)=>b-a)
      // 非面积“saddle”：以分量数量衡量多前沿潜力
      saddlePotential.set(c, compSizes.length)
    }
    let limitTry = ENABLE_BEAM ? Math.max(beamMin, Math.floor(dynamicWidth)) : 8
    const prevLB = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, regionSet) : lowerBound(curColors)) : 0
    const BF_W = Number.isFinite(self?.SOLVER_FLAGS?.bifrontWeight) ? self.SOLVER_FLAGS.bifrontWeight : 2.0
    let scored = prelim
      .map(({c, gain})=>{ 
        const pot=(enlargePotential.get(c)||0); 
        const saddle=(saddlePotential.get(c)||0);
        let score=gain*3 + pot*2 + saddle*BF_W + getBias(c); 
        let lbImproveRatio = 0
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
          let lb1 = 0
          if (ENABLE_LB){
            if (USE_STRICT_LB_BF){
              // 计算一步后的临时新区域（在颜色 c 内），用于严格下界
              const q1=[...regionSet]; const v1=new Set([...regionSet]); const newRegion1=new Set([...regionSet])
              while(q1.length){ const tid=q1.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!v1.has(nb) && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===c){ v1.add(nb); newRegion1.add(nb); q1.push(nb) } } }
              lb1 = lowerBoundStrictLocal(tmp, newRegion1)
            } else {
              lb1 = lowerBound(tmp)
            }
          }
          score += (prevLB - lb1) * 4 - lb1 * 1
          if (ENABLE_LB && prevLB > 0){ lbImproveRatio = Math.max(lbImproveRatio, Math.max(0, prevLB - lb1) / prevLB) }
        }
        if (FLAGS.enableLookaheadDepth2){
          const tmp = curColors.slice();
          for(const id of regionSet) tmp[idToIndex.get(id)] = c
          // 先构造一步后的新区域，再计算 lb1，避免使用未定义变量
          const q=[...regionSet]; const newRegionTmp=new Set([...regionSet]); const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===c){ visited2[nidx]=1; newRegionTmp.add(nb); q.push(nb) } } }
          const lb1 = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(tmp, newRegionTmp) : lowerBound(tmp)) : 0
          const adj2=new Set(); const gain2=new Map()
          for(const tid of newRegionTmp){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=tmp[nidx]; if(cc!==c && cc && cc!=='transparent' && !tri.deleted){ adj2.add(cc); gain2.set(cc,(gain2.get(cc)||0)+1) } } }
          const raw2 = adj2.size>0 ? [...adj2] : palette
          const preK2 = 4
          const prelim2 = raw2.map(c2=>({ c2, g:(gain2.get(c2)||0) }))
            .map(({c2,g})=>({ c2, score0: g*3 + getBias(c2) }))
            .sort((a,b)=>b.score0-a.score0)
            .slice(0, preK2)
          let bestLb2 = lb1
          for(const {c2} of prelim2){ const tmp2 = tmp.slice(); for(const id of newRegionTmp) tmp2[idToIndex.get(id)] = c2; const lb2 = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(tmp2, newRegionTmp) : lowerBound(tmp2)) : 0; if(lb2 < bestLb2) bestLb2 = lb2 }
          const twoStepImprove = Math.max(0, prevLB - bestLb2)
          if (ENABLE_LB && prevLB > 0){ lbImproveRatio = Math.max(lbImproveRatio, twoStepImprove / prevLB) }
          score += (prevLB - lb1) * 3 + (lb1 - bestLb2) * 2
        }
        return { c, score, lbImproveRatio }
      })
      .sort((a,b)=> b.score - a.score)
    const maxImproveRatio = scored.length ? Math.max(0, ...scored.map(s=>s.lbImproveRatio || 0)) : 0
    const widen = ENABLE_BEAM ? Math.min(0.5, maxImproveRatio) : 0
    limitTry = Math.min(tryColorsRaw.length, Math.max(limitTry, Math.floor(limitTry * (1 + widen))))
    const tryColors = scored.slice(0, limitTry).map(x=>x.c)
    for(const color of tryColors){
      if(color===regionColor) continue
      const nextColors = curColors.slice()
      for(const id of regionSet) nextColors[idToIndex.get(id)] = color
      const key = keyFromColors(nextColors)
      if(seen.has(key)) continue
      seen.add(key)
      const newRegion = new Set([...regionSet])
      const q=[...regionSet]
      const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
      while(q.length){
        const tid=q.shift()
        const idx=idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx=idToIndex.get(nb)
          const tri = triangles[nidx]
          if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){
            visited2[nidx]=1; newRegion.add(nb); q.push(nb)
          }
        }
      }
      const nextSteps = [...cur.steps, color]
      if (nextSteps.length > maxDepth) maxDepth = nextSteps.length
        if (nextSteps.length <= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
          // 过滤：零扩张候选（应用颜色后区域未增长）
          const delta = newRegion.size - regionSet.size
          if (ENABLE_ZERO_FILTER && delta <= 0) {
            perf.filteredZero++
            try { onProgress?.({ phase:'branch_pruned', reason:'zero_expand', step: nextSteps.length, color, delta, regionSize: regionSet.size }) } catch {}
            continue
          }
          // 准零扩张：相对增长过小则跳过（避免“几乎没用”的动作）
          const deltaRatio = delta / Math.max(1, regionSet.size)
          if (deltaRatio < MIN_DELTA_RATIO) {
            try { onProgress?.({ phase:'branch_pruned', reason:'delta_small', step: nextSteps.length, color, deltaRatio, regionSize: regionSet.size }) } catch {}
            continue
          }
          // 稀有颜色过滤：全局出现很少且桥接价值不显著时跳过（使用邻接后种类数作为桥接代理）
          const freq = (colorCount.get(color) || 0)
          const rareTh = Math.max(RARE_FREQ_ABS, Math.floor(triangles.length * RARE_FREQ_RATIO))
          if (freq < rareTh) {
            const { bridgePotential, gateScore } = computeBridgePotential(color, nextColors, newRegion)
            const adjAfter = computeAdjAfterSize(color, nextColors, newRegion)
            if (bridgePotential < RARE_ALLOW_BRIDGE_MIN && gateScore < RARE_ALLOW_GATE_MIN && adjAfter < RARE_ALLOW_BRIDGE_MIN) {
              try { onProgress?.({ phase:'branch_pruned', reason:'rare_no_bridge_gate', step: nextSteps.length, color, adjAfter, bridgePotential, gateScore }) } catch {}
              continue
            }
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
          let baseScore = (gain.get(color)||0)*3 + (enlargePotential.get(color)||0)*2 + getBias(color)
          if (ENABLE_BRIDGE_FIRST){
            const adjAfter = computeAdjAfterSize(color, nextColors, newRegion)
            const { bridgePotential, gateScore } = computeBridgePotential(color, nextColors, newRegion)
            const boundaryAfter = adjAfter
            baseScore += (boundaryBefore - boundaryAfter) * BOUNDARY_WEIGHT
            baseScore += adjAfter * ADJ_AFTER_WEIGHT + bridgePotential * BRIDGE_WEIGHT + gateScore * GATE_WEIGHT
            const expandPart = adjAfter * (DIM_WEIGHTS.expand || 1)
            const connectPart = (bridgePotential + gateScore) * (DIM_WEIGHTS.connect || 0.8)
            const barrierPart = (boundaryBefore - boundaryAfter) * (DIM_WEIGHTS.barrier || 0.7)
            baseScore += expandPart * (REGION_CLASS_WEIGHTS.boundary || 0.8)
            baseScore += connectPart * (REGION_CLASS_WEIGHTS.bridge || 1.0)
            baseScore += barrierPart * (REGION_CLASS_WEIGHTS.boundary || 0.8)
          }
      const childLB = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(nextColors, newRegion) : lowerBound(nextColors)) : 0
      // 下界改进不足：若一步后下界几乎不降，则跳过（局部计算当前下界），并上报原因
      if (ENABLE_LB) {
        const prevLBLocal = USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, regionSet) : lowerBound(curColors)
        if ((prevLBLocal - childLB) < LB_IMPROVE_MIN) {
          try { onProgress?.({ phase:'branch_pruned', reason:'lb_improve_small', step: nextSteps.length, color, prevLB: prevLBLocal, childLB, improve: (prevLBLocal - childLB) }) } catch {}
          continue
        }
        const improve = Math.max(0, prevLBLocal - childLB)
        if (improve <= 0) perf.lbHist.improve0++
        else if (improve <= 2) perf.lbHist.improve1_2++
        else if (improve <= 5) perf.lbHist.improve3_5++
        else perf.lbHist.improve6p++
      }
          const priority = baseScore - childLB * 2
          // 采样上报分支质量，便于事后分析路径选择与瓶颈
          try {
            if (onProgress && Math.random() < QUALITY_SAMPLE_RATE) {
              const adjAfterQ = computeAdjAfterSize(color, nextColors, newRegion)
              onProgress({ phase:'branch_quality', step: nextSteps.length, color, delta, deltaRatio, lb: childLB, priority, adjAfter: adjAfterQ })
            }
          } catch {}
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
        const raw = adjColors.size>0 ? [...adjColors] : palette
        const score=(c)=>{
          let s = (gain.get(c)||0)*3 + getBias(c)
          if (ENABLE_BRIDGE_FIRST){ s += computeAdjAfterSize(c, colors, regionSet) * ADJ_AFTER_WEIGHT }
          return s
        }
        return raw.sort((a,b)=>score(b)-score(a)).slice(0,8).filter(c=>c!==rc)
      }
      const startTs = Date.now()
      let dfsNodes = 0
      let lastDfsReportTs = startTime
      async function dfs(colors, regionSet, steps){
        if(isUniformSimple(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))) return steps
        if(steps.length>=stepLimit) return null
        if(Date.now()-startTs > TIME_BUDGET_MS) { timedOut = true; return null }
        if(onProgress && PROGRESS_DFS_INTERVAL_MS>0){
          const now = Date.now()
          if(now - lastDfsReportTs >= PROGRESS_DFS_INTERVAL_MS){
            lastDfsReportTs = now
            onProgress({ phase:'dfs', nodes: dfsNodes, depth: steps.length, elapsedMs: now - startTime, maxDepth: stepLimit })
          }
        }
        const tryColors = orderColors(colors, regionSet)
        for(const color of tryColors){
          const nextColors = colors.slice(); for(const id of regionSet) nextColors[idToIndex.get(id)] = color
          const key = keyFromColors(nextColors); if(seen.has(key)) continue; seen.add(key)
          const q=[...regionSet]; const newRegion=new Set([...regionSet]); const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } } }
          dfsNodes++
          if(onProgress && PROGRESS_DFS_INTERVAL_MS>0){
            const now = Date.now()
            if(now - lastDfsReportTs >= PROGRESS_DFS_INTERVAL_MS){
              lastDfsReportTs = now
              onProgress({ phase:'dfs', nodes: dfsNodes, depth: steps.length+1, elapsedMs: now - startTime, maxDepth: stepLimit })
            }
          }
          const res = await dfs(nextColors, newRegion, [...steps,color]); if(res) return res
          await new Promise(r=>setTimeout(r,0))
        }
        return null
      }
      const dfsRegion = buildRegion(startColors)
      const dfsRes = await dfs(startColors, dfsRegion, [])
      if(dfsRes){ onProgress?.({ phase:'solution', minSteps: dfsRes.length, solutions: 1, elapsedMs: Date.now() - startTime }); return { paths: [dfsRes], minSteps: dfsRes.length, timedOut } }
    }
    // 否则（仅当步数上限为无限时）：保留贪心近似路径用于参考
    if (!Number.isFinite(stepLimit)) {
      const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
      const neighbors = triangles.map(t=>t.neighbors)
      let colors = startColors.slice()
      const steps=[]
      let safeGuard=0
      const limit = 80
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
    // 有步数上限但未找到统一解：不返回近似方案，交由上层处理
    return { paths: [], minSteps: 0, timedOut }
  }
  const minSteps = solutions[0].length
  const paths = solutions.filter(s=>s.length===minSteps).slice(0, maxBranches)
  if (LOG_PERF) {
    try { console.log('[SolverWorker] Perf', { nodes, enqueued: perf.enqueued, expanded: perf.expanded, filteredZero: perf.filteredZero, elapsedMs: Date.now() - startTime }) } catch {}
  }
  return { paths, minSteps, timedOut }
}

// 严格 A* 最短路（可选开关 strictMode）：可采纳下界 + 转置表剪枝
async function StrictAStarMinSteps(triangles, startId, palette, onProgress, stepLimit=Infinity){
  const startTime = Date.now()
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  const TIME_BUDGET_MS = Number.isFinite(FLAGS?.workerTimeBudgetMs) ? Math.max(1000, FLAGS.workerTimeBudgetMs) : 300000
  const REPORT_INTERVAL_MS = Number.isFinite(FLAGS?.progressAStarIntervalMs) ? Math.max(0, FLAGS.progressAStarIntervalMs) : 80
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  const startColors = triangles.map(t=>t.color)
  let timedOut = false

  const buildRegion = (colors) => {
    const rc = colors[idToIndex.get(startId)]
    const rs = new Set(); const q=[startId]; const v=new Set([startId])
    while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
    return rs
  }
  const isUniformByColors = (colors) => isUniformSimple(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i],deleted:triangles[i]?.deleted})))
  const collectBoundaryNeighbors = (colors, regionSet) => {
    const rc = colors[idToIndex.get(startId)]
    const boundary = new Set()
    for (const tid of regionSet) {
      const idx = idToIndex.get(tid)
      for (const nb of neighbors[idx]) {
        const nidx = idToIndex.get(nb)
        if (nidx == null) continue
        const tri = triangles[nidx]
        const cc = colors[nidx]
        if (cc!==rc && cc && cc!=='transparent' && !tri.deleted) {
          boundary.add(nb)
        }
      }
    }
    return Array.from(boundary)
  }
  const lowerBoundStrict = (colors, regionSet) => {
    // 全局颜色离散下界（可采纳）
    let activeCount = 0
    const colorFreq = new Map()
    for(let i=0;i<triangles.length;i++){
      const t=triangles[i]; const c=colors[i]
      if(!t.deleted && c && c!=='transparent'){
        activeCount++
        colorFreq.set(c, (colorFreq.get(c)||0)+1)
      }
    }
    const lbColors = Math.max(0, colorFreq.size - 1)
    // 边界颜色下界（当前边界上的不同颜色数）
    const rc = colors[idToIndex.get(startId)]
    const frontier = new Set()
    for(const tid of regionSet){
      const idx=idToIndex.get(tid)
      for(const nb of neighbors[idx]){
        const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]
        if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ frontier.add(cc) }
      }
    }
    const lbFrontier = frontier.size
    // 桥接下界（结构化项）：当前边界上的不同颜色数的保守近似
    const lbBridge = lbFrontier
    // 面积增量下界：remaining / 单步最大可扩展数量（使用全局同色最大计数作为安全上界）
    const remaining = Math.max(0, activeCount - (regionSet?.size||0))
    let maxColorCount = 0
    for(const v of colorFreq.values()){ if(v>maxColorCount) maxColorCount=v }
    const lbArea = maxColorCount>0 ? Math.ceil(remaining / maxColorCount) : 0
    return Math.max(lbColors, lbFrontier, lbArea, lbBridge)
  }

  const seenBestG = new Map([[keyFromColors(startColors), 0]])
  const startRegion = buildRegion(startColors)
  const h0Strict = lowerBoundStrict(startColors, startRegion)
  const HEUR_NAME0 = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.heuristicName : null
  const HEUR0 = HEUR_NAME0 ? getHeuristic(HEUR_NAME0) : null
  const h0 = HEUR0 ? (HEUR0.isLayered ? HEUR0({ triangles, idToIndex, neighbors, startId }, startColors, startRegion, h0Strict) : Math.max(h0Strict, HEUR0({ triangles, idToIndex, neighbors, startId }, startColors, startRegion))) : h0Strict
  let open = [{ colors:startColors, region:startRegion, steps:[], g:0, f:h0, boundaryNeighbors: collectBoundaryNeighbors(startColors, startRegion) }]
  let nodes = 0
  let maxDepth = 0
  let lastReport = startTime
  // 初始颜色统计与离散度（基于初始图，不随搜索变化）
  const colorSize = new Map(); for(const t of triangles){ const c=t.color; if(!t.deleted && c && c!=='transparent'){ colorSize.set(c,(colorSize.get(c)||0)+1) } }
  const compCount = new Map();
  {
    const visitedC = new Set()
    for(const t of triangles){
      const c=t.color; if(!c || c==='transparent' || t.deleted) continue
      if(visitedC.has(t.id)) continue
      compCount.set(c, (compCount.get(c)||0)+1)
      const q=[t.id]; visitedC.add(t.id)
      while(q.length){ const u=q.shift(); const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); const tv=triangles[vIdx]; if(tv && !tv.deleted && tv.color===c && !visitedC.has(v)){ visitedC.add(v); q.push(v) } } }
    }
  }
  const getBiasStrict = (c)=> 1 / Math.max(1, (compCount.get(c)||1))
  const getDispersion = (c)=> (compCount.get(c)||0) / Math.max(1, (colorSize.get(c)||1))
  const DISP_W = Number.isFinite(FLAGS?.dispersionWeight) ? FLAGS.dispersionWeight : 0.6
  while(open.length){
    // 时间预算与进度上报
    const nowTs = Date.now()
    if (nowTs - startTime > TIME_BUDGET_MS) { timedOut = true; break }
    if (REPORT_INTERVAL_MS<=0 || (nowTs - lastReport) >= REPORT_INTERVAL_MS){
      lastReport = nowTs
      try { onProgress?.({ phase:'strict_astar', nodes, open: open.length, depth: maxDepth, elapsedMs: nowTs - startTime }) } catch {}
      await new Promise(r=>setTimeout(r,0))
    }
    // 取 f 最小状态
    open.sort((a,b)=> (a.f ?? Infinity) - (b.f ?? Infinity))
    const cur = open.shift(); if(!cur) break
    nodes++
    maxDepth = Math.max(maxDepth, cur.steps.length)
    if(isUniformByColors(cur.colors)){
      try {
        onProgress?.({ phase:'solution', minSteps: cur.steps.length, solutions: 1, elapsedMs: Date.now() - startTime })
        onProgress?.({ phase:'proof', method:'a_star', optimal:true, reason:'A* with admissible lower bound and f-ordering' })
      } catch {}
      return { paths: [cur.steps], minSteps: cur.steps.length, timedOut }
    }
    if (cur.steps.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) { continue }
    const rc = cur.colors[idToIndex.get(startId)]
    const adjColors = new Set(); const gain = new Map()
    const boundaryList = Array.isArray(cur.boundaryNeighbors) ? cur.boundaryNeighbors : collectBoundaryNeighbors(cur.colors, cur.region)
    for(const nb of boundaryList){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=cur.colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ adjColors.add(cc); gain.set(cc,(gain.get(cc)||0)+1) } }
    const tryColorsRaw = adjColors.size>0 ? [...adjColors] : palette
    const tryColors = tryColorsRaw
      .map(c=>({ c, score: (gain.get(c)||0)*3 + getBiasStrict(c)*0.5 + getDispersion(c)*DISP_W }))
      .sort((a,b)=> b.score - a.score)
      .map(x=>x.c)
    for(const color of tryColors){ if(color===rc) continue
      const nextColors = cur.colors.slice(); for(const id of cur.region){ nextColors[idToIndex.get(id)] = color }
      const key = keyFromColors(nextColors)
      const g = cur.steps.length + 1
      const prevG = seenBestG.get(key); if(prevG!=null && prevG <= g) continue
      const q=[...cur.region]; const newRegion=new Set([...cur.region])
      const visited2 = new Uint8Array(triangles.length); for(const id of cur.region){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
      while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!tri) continue; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } }
      }
      const HEUR_NAME = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.heuristicName : null
      const HEUR = HEUR_NAME ? getHeuristic(HEUR_NAME) : null
      const lbStrict = lowerBoundStrict(nextColors, newRegion)
      const h = HEUR ? (HEUR.isLayered ? HEUR({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion, lbStrict) : Math.max(lbStrict, HEUR({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion))) : lbStrict
      if (Number.isFinite(stepLimit) && (g + h) > stepLimit) { continue }
      const f = g + h
      seenBestG.set(key, g)
      // 增量构建下一状态的边界邻居缓存
      let nextBoundaryNeighbors
      {
        const boundarySet = new Set()
        for(const tid2 of newRegion){ const idx2=idToIndex.get(tid2); for(const nb2 of neighbors[idx2]){ const nidx2=idToIndex.get(nb2); if(nidx2==null) continue; const tri2=triangles[nidx2]; const c2=nextColors[nidx2]; if(c2!==color && c2 && c2!=='transparent' && !tri2.deleted){ boundarySet.add(nb2) } } }
        nextBoundaryNeighbors = Array.from(boundarySet)
      }
      open.push({ colors: nextColors, region: newRegion, steps: [...cur.steps, color], g, f, boundaryNeighbors: nextBoundaryNeighbors })
    }
  }
  // 若失败或超时：返回空路径，交由上层处理
  return { paths: [], minSteps: 0, timedOut }
}

// IDA*（迭代加深 A*）：使用强下界 h（LB_colors/LB_frontier/LB_area），并结合 Transposition Table（64位 Zobrist）去重
async function StrictIDAStarMinSteps(triangles, startId, palette, onProgress, stepLimit=Infinity){
  const startTime = Date.now()
  // 与 A* 保持一致的时间预算与进度间隔
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  const TIME_BUDGET_MS = Number.isFinite(FLAGS?.workerTimeBudgetMs) ? Math.max(1000, FLAGS.workerTimeBudgetMs) : 300000
  const REPORT_INTERVAL_MS = Number.isFinite(FLAGS?.progressAStarIntervalMs) ? Math.max(0, FLAGS.progressAStarIntervalMs) : 250
  const ENABLE_BRIDGE_FIRST = !!FLAGS.enableBridgeFirst
  const ADJ_AFTER_WEIGHT = Number.isFinite(FLAGS?.adjAfterWeight) ? FLAGS.adjAfterWeight : 0.6
  const BOUNDARY_WEIGHT = Number.isFinite(FLAGS?.boundaryWeight) ? FLAGS.boundaryWeight : 0.8
  const BF_W = Number.isFinite(FLAGS?.bifrontWeight) ? FLAGS.bifrontWeight : 2.0
  const ENABLE_TT_MINF = FLAGS.enableTTMinFReuse !== false
  let timedOut = false
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)

  const startColors = triangles.map(t=>t.color)
  const buildRegion = (colors)=>{
    const rc = colors[idToIndex.get(startId)]
    const rs = new Set(); const q=[startId]; const v=new Set([startId])
    while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
    return rs
  }
  const lowerBoundStrict = (colors, regionSet) => {
    let activeCount = 0
    const colorFreq = new Map()
    for(let i=0;i<triangles.length;i++){
      const t=triangles[i]; const c=colors[i]
      if(!t.deleted && c && c!=='transparent'){ activeCount++; colorFreq.set(c, (colorFreq.get(c)||0)+1) }
    }
    const lbColors = Math.max(0, colorFreq.size - 1)
    const rc = colors[idToIndex.get(startId)]
    const frontier = new Set()
    for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ frontier.add(cc) } } }
    const lbFrontier = frontier.size
    // 桥接下界（结构化项）：使用边界不同颜色计数的保守形式
    const lbBridge = lbFrontier
    const remaining = Math.max(0, activeCount - (regionSet?.size||0))
    let maxColorCount = 0; for(const v of colorFreq.values()){ if(v>maxColorCount) maxColorCount=v }
    const lbArea = maxColorCount>0 ? Math.ceil(remaining / maxColorCount) : 0
    return Math.max(lbColors, lbFrontier, lbArea, lbBridge)
  }
  // Zobrist 64位哈希（颜色 + 区域形状）
  const MASK64 = (1n<<64n) - 1n
  let seed = BigInt((startId||0) ^ (triangles.length<<1) ^ ((palette?.length||0)<<3))
  const rnd64 = ()=>{ seed = (seed * 6364136223846793005n + 1442695040888963407n) & MASK64; return seed }
  const zColor = Array(triangles.length).fill(0).map(()=> new Map())
  const zRegion = Array(triangles.length).fill(0).map(()=> rnd64())
  for(let i=0;i<triangles.length;i++){
    for(const c of palette){ zColor[i].set(c, rnd64()) }
  }
  const hashState = (colors, regionSet)=>{
    let h = 0n
    for(let i=0;i<triangles.length;i++){
      const t=triangles[i]; const c=colors[i]
      if(!t.deleted && c && c!=='transparent'){
        const zv = zColor[i].get(c); if(zv!=null) h ^= zv
      }
    }
    for(const tid of regionSet){ const idx=idToIndex.get(tid); h ^= (zRegion[idx]||0n) }
    return h.toString()
  }

  // 颜色集中度偏置（按初始图的同色连通分量数），轻量且随搜索保持不变
  const compCount = new Map()
  {
    const visitedC = new Set()
    for(const t of triangles){
      const c = t.color
      if(!c || c==='transparent' || t.deleted) continue
      if(visitedC.has(t.id)) continue
      compCount.set(c, (compCount.get(c)||0) + 1)
      const q=[t.id]; visitedC.add(t.id)
      while(q.length){
        const u=q.shift(); const uIdx=idToIndex.get(u)
        for(const v of neighbors[uIdx]){
          const vIdx=idToIndex.get(v); const tv=triangles[vIdx]
          if(tv && !tv.deleted && tv.color===c && !visitedC.has(v)){ visitedC.add(v); q.push(v) }
        }
      }
    }
  }
  const getBiasStrict = (c)=> 1 / Math.max(1, (compCount.get(c)||1))
  const colorSize = new Map(); for(const t of triangles){ const c=t.color; if(!t.deleted && c && c!=='transparent'){ colorSize.set(c,(colorSize.get(c)||0)+1) } }
  const getDispersion = (c)=> (compCount.get(c)||0) / Math.max(1, (colorSize.get(c)||1))

  // 全局 TT：跨迭代保留 min(g) 与 min(f)，支持更强复用
  const globalTT = new Map()
  const DISP_W = Number.isFinite(FLAGS?.dispersionWeight) ? FLAGS.dispersionWeight : 0.6
  const perf = { expanded: 0, prunedBound: 0, prunedTTG: 0, prunedTTF: 0, prunedStepLimit: 0 }

  const startRegion = buildRegion(startColors)
  const h0 = lowerBoundStrict(startColors, startRegion)
  if (Number.isFinite(stepLimit) && h0 > stepLimit) {
    return { paths: [], minSteps: 0, timedOut }
  }
  let bound = h0
  let nodes = 0
  let maxDepth = 0
  let lastReport = startTime

  async function dfs(colors, regionSet, g, boundCur, path, tt, boundaryNeighbors){
    // 进度与时间预算
    const nowTs = Date.now()
    if (nowTs - startTime > TIME_BUDGET_MS) { timedOut = true; return { found:false, nextBound: Infinity, path: null } }
    if (REPORT_INTERVAL_MS<=0 || (nowTs - lastReport) >= REPORT_INTERVAL_MS){
      lastReport = nowTs
      try { onProgress?.({ phase:'strict_idastar', nodes, depth: maxDepth, bound: boundCur, elapsedMs: nowTs - startTime, perf }) } catch {}
      await new Promise(r=>setTimeout(r,0))
    }
    // 完成判定
    if(isUniformSimple(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))){
      try {
        onProgress?.({ phase:'solution', minSteps: path.length, solutions: 1, elapsedMs: Date.now() - startTime })
        onProgress?.({ phase:'proof', method:'ida_star', optimal:true, reason:'IDA* with admissible lower bound and monotone f-bound' })
      } catch {}
      return { found:true, nextBound: boundCur, path }
    }
    // 步数限制
    if (path.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
      perf.prunedStepLimit++
      return { found:false, nextBound: Infinity, path: null }
    }
    // 下界与 f 值
    const HEUR_NAME = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.heuristicName : null
    const HEUR = HEUR_NAME ? getHeuristic(HEUR_NAME) : null
    const lbStrictCur = lowerBoundStrict(colors, regionSet)
    const h = HEUR ? (HEUR.isLayered ? HEUR({ triangles, idToIndex, neighbors, startId }, colors, regionSet, lbStrictCur) : Math.max(lbStrictCur, HEUR({ triangles, idToIndex, neighbors, startId }, colors, regionSet))) : lbStrictCur
    const f = g + h
    if (f > boundCur) { perf.prunedBound++; return { found:false, nextBound: f, path: null } }

    // TT 去重：保留更小的 g
    const key = hashState(colors, regionSet)
    const prevG = tt.get(key)
    if (prevG!=null && prevG <= g) { perf.prunedTTG++; return { found:false, nextBound: Infinity, path: null } }
    // 跨迭代复用：若已见过更小的 f 或更小的 g，则也可剪枝
    if (ENABLE_TT_MINF){
      const prev = globalTT.get(key)
      if (prev){
        if (prev.gMin <= g) { perf.prunedTTG++; return { found:false, nextBound: Infinity, path: null } }
        if ((prev.fMin ?? Infinity) <= f) { perf.prunedTTF++; return { found:false, nextBound: Infinity, path: null } }
      }
      const rec = globalTT.get(key)
      const gMin = Math.min(rec?.gMin ?? Infinity, g)
      const fMin = Math.min(rec?.fMin ?? Infinity, f)
      globalTT.set(key, { gMin, fMin })
    }
    tt.set(key, g)

    const rc = colors[idToIndex.get(startId)]
    const adjColors = new Set(); const gain = new Map()
    const boundaryList = Array.isArray(boundaryNeighbors) ? boundaryNeighbors : (function(){
      const bset = new Set();
      for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(nidx==null) continue; if(colors[nidx]!==rc){ bset.add(nb) } } }
      return Array.from(bset)
    })()
    for(const nb of boundaryList){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ adjColors.add(cc); gain.set(cc,(gain.get(cc)||0)+1) } }
    const tryColorsRaw = adjColors.size>0 ? [...adjColors] : palette
    const boundaryBefore = adjColors.size
    // 预选少量候选用于计算边界扩张与 saddle 潜力（轻量近似）
    const basePreK = 6
    const prelim = tryColorsRaw.map(c=>{
      const g0 = (gain.get(c)||0)
      const score0 = g0*3 + getBiasStrict(c)
      return { c, score0, gain:g0 }
    }).sort((a,b)=> b.score0 - a.score0).slice(0, basePreK)
    // 收集边界邻居（与当前区域相邻且不同色）
    const regionBoundaryNeighbors = []
    for(const tid of regionSet){
      const idx = idToIndex.get(tid)
      for(const nb of neighbors[idx]){
        const nidx = idToIndex.get(nb)
        if (nidx==null) continue
        if (colors[nidx] !== rc){ regionBoundaryNeighbors.push(nb) }
      }
    }
    const enlargePotential = new Map()
    const saddlePotential = new Map()
    for(const {c} of prelim){
      const seeds = []
      for(const nb of regionBoundaryNeighbors){ const nbIdx=idToIndex.get(nb); if(nbIdx!=null && colors[nbIdx]===c){ seeds.push(nb) } }
      const seedSet = new Set(seeds)
      const visitedB = new Set(); let compCountB = 0
      for(const s of seeds){ if(visitedB.has(s)) continue; compCountB++; const qB=[s]; visitedB.add(s); while(qB.length){ const u=qB.shift(); const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx!=null && seedSet.has(v) && !visitedB.has(v) && colors[vIdx]===c){ visitedB.add(v); qB.push(v) } } } }
      const boundarySeedCount = seeds.length
      enlargePotential.set(c, boundarySeedCount * 1.0 + Math.max(0, boundarySeedCount - compCountB) * 0.5)
      const visitedS = new Set(); const compSizes=[]
      for(const s of seeds){ if(visitedS.has(s)) continue; let size=0; const q=[s]; visitedS.add(s); while(q.length){ const u=q.shift(); size++; const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx==null) continue; if(!visitedS.has(v) && colors[vIdx]===c){ visitedS.add(v); q.push(v) } } }
      }
      compSizes.sort((a,b)=>b-a)
      saddlePotential.set(c, compSizes.length)
    }
    const tryColors = tryColorsRaw
      .map(c=>{
        const g0 = (gain.get(c)||0)
        const pot = (enlargePotential.get(c)||0)
        const saddle = (saddlePotential.get(c)||0)
        let score = g0*3 + pot*2 + saddle*BF_W + getBiasStrict(c) + getDispersion(c)*DISP_W
        if (ENABLE_BRIDGE_FIRST){
          const adjAfter = computeAdjAfterSize(c, colors, regionSet)
          score += (boundaryBefore - adjAfter) * BOUNDARY_WEIGHT
          score += adjAfter * ADJ_AFTER_WEIGHT
        }
        return { c, score }
      })
      .sort((a,b)=> b.score - a.score)
      .map(x=>x.c)
    let minNextBound = Infinity
    for(const color of tryColors){ if(color===rc) continue
      const nextColors = colors.slice(); for(const id of regionSet){ nextColors[idToIndex.get(id)] = color }
      // 新区域扩张（颜色相同）
      const q=[...regionSet]; const newRegion=new Set([...regionSet]); const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
      while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } } }
      const gNext = g + 1
      const HEUR_NAME2 = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.heuristicName : null
      const HEUR2 = HEUR_NAME2 ? getHeuristic(HEUR_NAME2) : null
      const lbStrictNext = lowerBoundStrict(nextColors, newRegion)
      const hNext = HEUR2 ? (HEUR2.isLayered ? HEUR2({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion, lbStrictNext) : Math.max(lbStrictNext, HEUR2({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion))) : lbStrictNext
      const fNext = gNext + hNext
      if (Number.isFinite(stepLimit) && fNext > stepLimit) { minNextBound = Math.min(minNextBound, fNext); continue }
      nodes++
      maxDepth = Math.max(maxDepth, path.length+1)
      perf.expanded++
      // 增量构建下一状态的边界邻居缓存
      let nextBoundaryNeighbors
      {
        const boundarySet = new Set()
        for(const tid2 of newRegion){ const idx2=idToIndex.get(tid2); for(const nb2 of neighbors[idx2]){ const nidx2=idToIndex.get(nb2); if(nidx2==null) continue; const tri2=triangles[nidx2]; const c2=nextColors[nidx2]; if(c2!==color && c2 && c2!=='transparent' && !tri2.deleted){ boundarySet.add(nb2) } } }
        nextBoundaryNeighbors = Array.from(boundarySet)
      }
      const res = await dfs(nextColors, newRegion, gNext, boundCur, [...path, color], tt, nextBoundaryNeighbors)
      if (res.found) return res
      minNextBound = Math.min(minNextBound, res.nextBound)
    }
    return { found:false, nextBound: minNextBound, path: null }
  }

  while(true){
    const tt = new Map([[hashState(startColors, startRegion), 0]])
    // 初始化起点的边界邻居缓存
    const initBoundary = (function(){
      const rc0 = startColors[idToIndex.get(startId)]
      const bset = new Set()
      for(const tid of startRegion){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(nidx==null) continue; if(startColors[nidx]!==rc0){ bset.add(nb) } } }
      return Array.from(bset)
    })()
    const res = await dfs(startColors, startRegion, 0, bound, [], tt, initBoundary)
    if (res.found) { return { paths: [res.path], minSteps: res.path.length, timedOut } }
    if (timedOut) { return { paths: [], minSteps: 0, timedOut } }
    if (!Number.isFinite(res.nextBound) || res.nextBound===Infinity) { return { paths: [], minSteps: 0, timedOut } }
    bound = res.nextBound
    if (Number.isFinite(stepLimit) && bound > stepLimit) { return { paths: [], minSteps: 0, timedOut } }
  }
}

async function Solver_minStepsAuto(triangles, palette, maxBranches=3, onProgress, stepLimit=Infinity){
  const startTime = Date.now()
  // 计算时限：可通过 SOLVER_FLAGS.workerTimeBudgetMs 配置（默认 300000 ms）
  const TIME_BUDGET_MS = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.workerTimeBudgetMs))
    ? Math.max(1000, self.SOLVER_FLAGS.workerTimeBudgetMs)
    : 300000
  let timedOut = false
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  // 预处理（components）阶段单独时间预算，默认 5 分钟，可调
  const PREPROC_TIME_BUDGET_MS = Number.isFinite(FLAGS?.preprocessTimeBudgetMs)
    ? Math.max(0, FLAGS.preprocessTimeBudgetMs)
    : 300000
  const PROG_COMP_INTERVAL = Number.isFinite(FLAGS?.progressComponentsIntervalMs) ? Math.max(0, FLAGS.progressComponentsIntervalMs) : 100
  const PROGRESS_DFS_INTERVAL_MS = Number.isFinite(FLAGS?.progressDFSIntervalMs) ? Math.max(0, FLAGS.progressDFSIntervalMs) : 50
  const USE_DFS_FIRST = !!FLAGS.useDFSFirst
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  const visited = new Set()
  const components = []
  let compLastTs = startTime
  for(const t of triangles){
    // 超过预处理阶段时间预算则提前结束组件识别
    if ((Date.now() - startTime) > PREPROC_TIME_BUDGET_MS) {
      break
    }
    const id = t.id
    if(visited.has(id)) continue
    if(t.deleted || t.color==='transparent') continue
    const color = t.color
    const comp=[]
    const q=[id]
    visited.add(id)
    while(q.length){
      // 若预处理阶段超时，在构建当前分量时也立即退出
      if ((Date.now() - startTime) > PREPROC_TIME_BUDGET_MS) {
        break
      }
      const cid=q.shift()
      const idx=idToIndex.get(cid)
      const tri=triangles[idx]
      if(tri.deleted || tri.color==='transparent' || tri.color!==color) continue
      comp.push(cid)
      for(const nb of neighbors[idx]){ if(!visited.has(nb)){ const nidx=idToIndex.get(nb); const tri2=triangles[nidx]; if(!tri2.deleted && tri2.color!=='transparent' && tri2.color===color){ visited.add(nb); q.push(nb) } } }

      // 组件构建中的细粒度进度（时间节流），包含当前分量大小与颜色
      if (onProgress) {
        const nowTs = Date.now()
        if (PROG_COMP_INTERVAL <= 0 || (nowTs - compLastTs) >= PROG_COMP_INTERVAL) {
          compLastTs = nowTs
          onProgress({ phase:'components_build', count: components.length, compSize: comp.length, color, elapsedMs: nowTs - startTime })
          // 让出事件循环以便主线程 UI 刷新
          await new Promise(r=>setTimeout(r,0))
        }
      }
    }
    if(comp.length>0){
      components.push({ color, ids: comp, startId: comp[0], size: comp.length })
      const nowTs = Date.now()
      // 更频繁的组件阶段进度：每个组件打点，并附带 elapsedMs；可选时间节流
      if (onProgress) {
        if (PROG_COMP_INTERVAL <= 0 || (nowTs - compLastTs) >= PROG_COMP_INTERVAL) {
          compLastTs = nowTs
          onProgress({ phase:'components', count: components.length, elapsedMs: nowTs - startTime })
          // 让出事件循环，确保主线程能及时刷新显示
          await new Promise(r=>setTimeout(r,0))
        } else {
          onProgress({ phase:'components', count: components.length, elapsedMs: nowTs - startTime })
        }
      }
    }
  }
  // 预处理阶段结束：无论耗时长短，输出一次总结打点，便于判定阶段完成
  {
    const nowTs = Date.now()
    const largest = components.length>0 ? components.reduce((m,c)=> Math.max(m, c.size||0), 0) : 0
    const summary = { phase:'components_done', count: components.length, largest, elapsedMs: nowTs - startTime }
    try { onProgress?.(summary) } catch {}
  }
  // 预处理分析：颜色离散度、桥接潜力与分量分类
  {
    const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
    const ENABLE_ANALYSIS_ORDER = !!FLAGS.preprocessEnableAnalysisOrder
    const DISPERSION_THRESH = Number.isFinite(FLAGS.dispersionThreshold) ? FLAGS.dispersionThreshold : 0.2
    const BRIDGE_DENSITY_THRESH = Number.isFinite(FLAGS.bridgeEdgeDensityThreshold) ? FLAGS.bridgeEdgeDensityThreshold : 0.4

    const colorStats = new Map()
    const compDetails = []
    for (const comp of components) {
      const color = comp.color
      let borderCross = 0
      for (const id of comp.ids) {
        const idx = idToIndex.get(id)
        for (const nb of neighbors[idx]) {
          const nidx = idToIndex.get(nb)
          if (nidx == null) continue
          const t2 = triangles[nidx]
          if (t2.deleted || t2.color==='transparent') continue
          if (t2.color !== color) borderCross++
        }
      }
      const size = comp.size || comp.ids.length || 0
      const entry = colorStats.get(color) || { color, compCount:0, totalSize:0, bridgeEdges:0 }
      entry.compCount += 1
      entry.totalSize += size
      entry.bridgeEdges += borderCross
      colorStats.set(color, entry)
      const bridgeDensity = size>0 ? (borderCross / (size*3)) : 0
      const tags = []
      if (bridgeDensity >= BRIDGE_DENSITY_THRESH) tags.push('bridge')
      if (size >= Math.max(20, Math.ceil(triangles.length*0.05))) tags.push('core')
      compDetails.push({ color, startId: comp.startId, size, bridgeEdges: borderCross, bridgeDensity, tags })
    }
    const colorsSummary = Array.from(colorStats.values()).map(s=>({
      color: s.color,
      compCount: s.compCount,
      totalSize: s.totalSize,
      avgSize: s.totalSize>0 ? Math.round(s.totalSize / s.compCount) : 0,
      dispersion: s.totalSize>0 ? (s.compCount / s.totalSize) : 0,
      bridgeEdges: s.bridgeEdges,
    }))
    // 基于分析的分量重排（可选）
    if (ENABLE_ANALYSIS_ORDER) {
      const dispersionByColor = new Map(colorsSummary.map(s=>[s.color, s.dispersion]))
      components.sort((a,b)=>{
        const da = dispersionByColor.get(a.color) || 0
        const db = dispersionByColor.get(b.color) || 0
        const aBridge = (compDetails.find(d=>d.startId===a.startId)?.bridgeDensity || 0) >= BRIDGE_DENSITY_THRESH
        const bBridge = (compDetails.find(d=>d.startId===b.startId)?.bridgeDensity || 0) >= BRIDGE_DENSITY_THRESH
        // 优先处理高离散度颜色的桥接分量，其次按分量大小降序
        if ((da>=DISPERSION_THRESH) !== (db>=DISPERSION_THRESH)) return (db>=DISPERSION_THRESH) - (da>=DISPERSION_THRESH)
        if (aBridge !== bBridge) return (bBridge?1:0) - (aBridge?1:0)
        return (b.size||0) - (a.size||0)
      })
    }
    try {
      onProgress?.({ phase:'components_analysis', count: components.length, colors: colorsSummary, topComponents: compDetails.slice(0, 8) })
    } catch {}
  }
  if(components.length===0) return { bestStartId: null, paths: [], minSteps: 0 }
  // 若指定了优先起点，则将对应分量置顶
  try {
    const preferred = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.preferredStartId : null
    if (preferred!=null) {
      const idx = components.findIndex(c=>c.startId===preferred)
      if (idx>0) { const [c] = components.splice(idx,1); components.unshift(c) }
    }
  } catch {}
  components.sort((a,b)=>b.size-a.size)
  let best={ startId:null, minSteps: Infinity, paths: [] }
  for(const comp of components){
    if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break }
    await new Promise(r=>setTimeout(r,0))
    // 严格模式：若开启则优先用 A* 求最短路
      if (!!FLAGS.strictMode) {
      const useIDA = !!FLAGS.useIDAStar
      const resStrict = useIDA
        ? await StrictIDAStarMinSteps(triangles, comp.startId, palette, (p)=>{ onProgress?.({ phase:'subsearch', startId: comp.startId, ...p }) }, stepLimit)
        : await StrictAStarMinSteps(triangles, comp.startId, palette, (p)=>{ onProgress?.({ phase:'subsearch', startId: comp.startId, ...p }) }, stepLimit)
      if(resStrict && resStrict.paths && resStrict.paths.length>0){
        if(resStrict.minSteps < best.minSteps){ best = { startId: comp.startId, minSteps: resStrict.minSteps, paths: resStrict.paths }; onProgress?.({ phase:'best_update', bestStartId: best.startId, minSteps: best.minSteps }) }
        if (Number.isFinite(stepLimit) && resStrict.minSteps <= stepLimit) { break }
        if (resStrict.timedOut) timedOut = true
      }
      continue
    }
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
          const raw = adjColors.size>0 ? [...adjColors] : palette
          const score=(c)=>{ let s=(gain.get(c)||0)*3 + getBias(c); return s }
          return raw.sort((a,b)=>score(b)-score(a)).slice(0,8).filter(c=>c!==rc)
        }
        const startTs = Date.now()
        let dfsNodesFirst = 0
        let lastDfsReportTsFirst = startTime
        async function dfs(colors, regionSet, steps){
          if(isUniformSimple(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))) return steps
          if(steps.length>=stepLimit) return null
          if(Date.now()-startTs > TIME_BUDGET_MS) { timedOut = true; return null }
          if(onProgress && PROGRESS_DFS_INTERVAL_MS>0){
            const now = Date.now()
            if(now - lastDfsReportTsFirst >= PROGRESS_DFS_INTERVAL_MS){
              lastDfsReportTsFirst = now
              onProgress({ phase:'dfs_first', nodes: dfsNodesFirst, depth: steps.length, elapsedMs: now - startTime, maxDepth: stepLimit })
            }
          }
          const tryColors = orderColors(colors, regionSet)
          for(const color of tryColors){
            const nextColors = colors.slice(); for(const id of regionSet) nextColors[idToIndex.get(id)] = color
            const key = keyFromColors(nextColors); if(seen.has(key)) continue; seen.add(key)
            const q=[...regionSet]; const newRegion=new Set([...regionSet]); const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
            while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } }
            }
            dfsNodesFirst++
            if(onProgress && PROGRESS_DFS_INTERVAL_MS>0){
              const now = Date.now()
              if(now - lastDfsReportTsFirst >= PROGRESS_DFS_INTERVAL_MS){
                lastDfsReportTsFirst = now
                onProgress({ phase:'dfs_first', nodes: dfsNodesFirst, depth: steps.length+1, elapsedMs: now - startTime, maxDepth: stepLimit })
              }
            }
            const res = await dfs(nextColors, newRegion, [...steps,color]); if(res) return res
            await new Promise(r=>setTimeout(r,0))
          }
          return null
        }
        const dfsRegion = buildRegion(startColors)
        const dfsRes = await dfs(startColors, dfsRegion, [])
        if(dfsRes){
          // 仅在显式允许“找到可行解立即返回”时，才提前输出结果
          const RETURN_FIRST = !!FLAGS.returnFirstFeasible
          onProgress?.({ phase:'dfs_first_solution', minSteps: dfsRes.length, solutions: 1, elapsedMs: Date.now() - startTime })
          if (RETURN_FIRST) {
            return { paths:[dfsRes], minSteps: dfsRes.length, timedOut }
          }
          // 否则继续进行标准最短路搜索，不提前返回
        }
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
  const originalPath = Array.isArray(path) ? path.slice() : []
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
  // 若当前路径不统一：不再早退，记录后跳过局部优化，直接进入全局重算阶段
  let tmpColors = colors.slice()
  for(const stepColor of path){
    const region = buildRegion(tmpColors, startId)
    for(const id of region){ tmpColors[idToIndex.get(id)] = stepColor }
  }
  const initiallyUniform = isUniformFast(tmpColors)
  if(!initiallyUniform){
    onProgress?.({ phase:'analysis', ok:false, reason:'path_not_unified' })
  }
  // 计算每一步的增益，识别关键节点
  const gains=[]
  let simColors = colors.slice()
  for(const color of path){
    const region = buildRegion(simColors, startId)
    const before = region.size
    // 应用颜色并扩张新区域
    const next = simColors.slice(); for(const id of region) next[idToIndex.get(id)] = color
    const q=[...region]; const newRegion=new Set([...region]); const visited2 = new Uint8Array(triangles.length); for(const id of region){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
    while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && next[nidx]===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } }
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
  if (initiallyUniform && OPT_ENABLE_WINDOW && OPT_WINDOW_SIZE>1){
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
  // 进一步：窗口束搜索（Beam），在局部窗口内尝试多候选排序以寻求更短压缩
  const OPT_ENABLE_BEAM = self.SOLVER_FLAGS?.optimizeEnableBeamWindow !== false
  let OPT_BEAM_WIDTH = Number.isFinite(self.SOLVER_FLAGS?.optimizeBeamWidth) ? self.SOLVER_FLAGS.optimizeBeamWidth : 4
  let OPT_BEAM_WINDOWS = Number.isFinite(self.SOLVER_FLAGS?.optimizeBeamWindows) ? self.SOLVER_FLAGS.optimizeBeamWindows : 2
  if (initiallyUniform && OPT_ENABLE_BEAM && OPT_WINDOW_SIZE>1 && OPT_BEAM_WIDTH>1){
    const applyPath = (p)=>{ let cc=triangles.map(t=>t.color); for(const c of p){ const reg=buildRegion(cc,startId); for(const id of reg){ cc[idToIndex.get(id)]=c } } return cc }
    const compressAdj = (arr)=>{ const out=[]; for(const c of arr){ if(out.length===0 || out[out.length-1]!==c) out.push(c) } return out }
    const scoreSeg = (seg, cc)=>{
      // 简化：使用窗口重排度量中的 priority 近似评分
      const idIdx=idToIndex; const neigh=neighbors
      let curColors = cc.slice(); let s=0
      for(const color of seg){
        const region = buildRegion(curColors, startId)
        const rc = curColors[idIdx.get(startId)]
        const adjSet=new Set(); for(const tid of region){ const idx=idIdx.get(tid); for(const nb of neigh[idx]){ const nidx=idIdx.get(nb); const cc2=curColors[nidx]; if(cc2!==rc && cc2 && cc2!=='transparent'){ adjSet.add(cc2) } } }
        const beforeAdj=adjSet.size
        const tmp=curColors.slice(); for(const id of region){ tmp[idIdx.get(id)]=color }
        const reg2=new Set([...region]); const q=[...region]; const visited=new Set([...region])
        while(q.length){ const tid=q.shift(); const idx=idIdx.get(tid); for(const nb of neigh[idx]){ const nidx=idIdx.get(nb); const tri=triangles[nidx]; if(!visited.has(nb) && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===color){ visited.add(nb); reg2.add(nb); q.push(nb) } } }
        const adjSet2=new Set(); for(const tid of reg2){ const idx=idIdx.get(tid); for(const nb of neigh[idx]){ const nidx=idIdx.get(nb); const cc3=tmp[nidx]; if(cc3!==color && cc3 && cc3!=='transparent'){ adjSet2.add(cc3) } } }
        const afterAdj=adjSet2.size
        const barrierDelta=Math.max(0,beforeAdj-afterAdj)
        const expandAdj=afterAdj
        const priority = (((self.SOLVER_FLAGS?.dimensionWeights?.expand)||1)*expandAdj + ((self.SOLVER_FLAGS?.dimensionWeights?.barrier)||0.7)*barrierDelta)
        s+=priority
        for(const id of region){ curColors[idIdx.get(id)]=color }
      }
      return s
    }
    const genCandidates = (seg)=>{
      const uniq = Array.from(seg)
      // 生成若干候选：降序、升序、相邻交换组合
      const freq = new Map(); uniq.forEach(c=>freq.set(c,(freq.get(c)||0)+1))
      const baseAsc = uniq.slice().sort()
      const baseDesc = uniq.slice().sort().reverse()
      const cand=[uniq, baseAsc, baseDesc]
      if(uniq.length>=2) cand.push([uniq[1],uniq[0],...uniq.slice(2)])
      if(uniq.length>=3) cand.push([uniq[2],uniq[0],uniq[1],...uniq.slice(3)])
      // 去重
      const seen=new Set(); const out=[]
      for(const c of cand){ const k=c.join('|'); if(!seen.has(k)){ seen.add(k); out.push(c) } }
      return out
    }
    let attempts=0
    const maxPass = Math.max(1, OPT_BEAM_WINDOWS)
    while(attempts<maxPass){
      attempts++
      let improved=false
      for(let i=0;i+OPT_WINDOW_SIZE<=path.length;i+=OPT_WINDOW_SIZE){
        const seg = path.slice(i, i+OPT_WINDOW_SIZE)
        const ccBefore = applyPath(path.slice(0,i))
        const cands = genCandidates(seg)
        const scored = cands.map(s=>({ s, score: scoreSeg(s, ccBefore) }))
        scored.sort((a,b)=> b.score - a.score)
        const top = scored.slice(0, OPT_BEAM_WIDTH)
        for(const cand of top){
          const tryPath = path.slice(0,i).concat(cand.s, path.slice(i+OPT_WINDOW_SIZE))
          const colorsTest = applyPath(tryPath)
          if(!isUniformFast(colorsTest)) continue
          const lenOrig = compressAdj(path).length
          const lenNew = compressAdj(tryPath).length
          if(lenNew < lenOrig){ path = tryPath; improved=true; onProgress?.({ phase:'optimize_beam', at:i, len:lenNew }) ; break }
        }
      }
      if(!improved) break
    }
  }
  // 反思压缩：尝试移除低优先步骤（仍能统一颜色）
  const OPT_ENABLE_REMOVAL = self.SOLVER_FLAGS?.optimizeEnableRemoval !== false
  if (initiallyUniform && OPT_ENABLE_REMOVAL){
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
  if (initiallyUniform && OPT_ENABLE_BOUND_TRIM){
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
  if (initiallyUniform && OPT_ENABLE_SWAP && path.length>1){
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
  const targetLimit = Math.max(0, path.length-1)
  let res = await Solver_minStepsAuto(triangles, palette, 3, (p)=>{ onProgress?.({ ...p, phase: p?.phase || 'optimize_search' }) }, targetLimit)
  // 若首轮未改善，尝试第二轮：调整权重偏向桥接与扩张
  if(!(res && res.paths && res.paths.length>0 && res.minSteps < path.length)){
    const FLAGS2 = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
    const prevUseDFS2 = FLAGS2.useDFSFirst
    const prevReturn2 = FLAGS2.returnFirstFeasible
    const prevAdj = FLAGS2.adjAfterWeight
    const prevBoundary = FLAGS2.boundaryWeight
    const prevBridge = FLAGS2.bridgeWeight
    try { self.SOLVER_FLAGS = { ...FLAGS2, useDFSFirst: true, returnFirstFeasible: true, adjAfterWeight: Math.max(0.4, (prevAdj??0.6)*1.2), boundaryWeight: Math.max(0.6, (prevBoundary??0.8)*1.1), bridgeWeight: Math.max(1.0, (prevBridge??1.0)*1.3) } } catch {}
    onProgress?.({ phase:'optimize_search_round2' })
    res = await Solver_minStepsAuto(triangles, palette, 3, (p)=>{ onProgress?.({ ...p, phase: p?.phase || 'optimize_search_round2' }) }, targetLimit)
    try { self.SOLVER_FLAGS = { ...self.SOLVER_FLAGS, useDFSFirst: prevUseDFS2, returnFirstFeasible: prevReturn2, adjAfterWeight: prevAdj, boundaryWeight: prevBoundary, bridgeWeight: prevBridge } } catch {}
  }
  try { self.SOLVER_FLAGS = { ...self.SOLVER_FLAGS, useDFSFirst: prevUseDFS, returnFirstFeasible: prevReturn } } catch {}
  if(res && res.paths && res.paths.length>0 && res.minSteps < path.length){
    // 双重一致性校验：确保返回路径统一颜色
    let verifyColors = triangles.map(t=>t.color)
    for(const c of res.paths[0]){ const reg = buildRegion(verifyColors, startId); for(const id of reg){ verifyColors[idToIndex.get(id)] = c } }
    if(isUniformFast(verifyColors)){
      onProgress?.({ phase:'optimized', improved: true, minSteps: res.minSteps })
      return { bestStartId: res.bestStartId ?? startId, optimizedPath: res.paths[0], originalLen: path.length, optimizedLen: res.minSteps, shortened: true, analysis: { ok:true, critical } }
    } else {
      onProgress?.({ phase:'optimized_invalid', reason:'not_uniform_res', length: res.minSteps })
    }
  } else {
    // 最终一致性校验：若优化后的路径不能统一颜色，则回退到原始路径
    let finalColors = triangles.map(t=>t.color)
    for(const c of path){ const reg = buildRegion(finalColors, startId); for(const id of reg){ finalColors[idToIndex.get(id)] = c } }
    const okUniform = (function(colorsArr){
      let first=null
      for(let i=0;i<triangles.length;i++){ const t=triangles[i]; const c=colorsArr[i]; if(t.deleted || !c || c==='transparent') continue; if(first===null){ first=c } else if(c!==first){ return false } }
      return first!==null
    })(finalColors)
    if(!okUniform){
      onProgress?.({ phase:'optimized_invalid', reason:'not_uniform', length: path.length })
      return { bestStartId: startId, optimizedPath: originalPath, originalLen: originalPath.length, optimizedLen: originalPath.length, shortened: false, analysis: { ok:false, reason:'not_uniform_after_opt' } }
    }
    onProgress?.({ phase:'optimized', improved: false })
    return { bestStartId: startId, optimizedPath: path, originalLen: originalPath.length, optimizedLen: path.length, shortened: path.length < originalPath.length, analysis: { ok:true, critical } }
  }
}

self.onmessage = async (e) => {
  const { type, triangles, palette, maxBranches, stepLimit, ragOptions, flags, preferredStartId } = e.data || {}
  // 支持在运行前设置或更新 flags（从主线程传入）
  if (type === 'set_flags') {
    try { self.SOLVER_FLAGS = { ...(self.SOLVER_FLAGS||{}), ...(flags||{}) } } catch {}
    self.postMessage({ type:'flags_set', payload: { ok: true } })
    return
  }
  if(type==='auto'){
    // 若提供了优先起点，将其所在分量优先处理
    if (preferredStartId!=null && Array.isArray(triangles)) {
      try {
        const idxMap = new Map(triangles.map((t,i)=>[t.id,i]))
        const targetIdx = idxMap.get(preferredStartId)
        if (targetIdx!=null) {
          // 轻量标记：通过全局 flags 传递优先起点，供自动解排序阶段使用
          self.SOLVER_FLAGS = { ...(self.SOLVER_FLAGS||{}), preferredStartId }
        }
      } catch {}
    }
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