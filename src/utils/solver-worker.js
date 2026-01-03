import { buildRAG, colorFrequency } from './grid-utils'
import { getHeuristic } from './heuristics'
import { loadPDBObject } from './pdb'
import { mctsSolve } from './mcts'
import { localRepair } from './local-repair'
import { satMacroColorPlan } from './sat'
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
  // 计算总时限：固定 3 分钟（用户要求：不因重试/节点上限提前停止）
  // 注意：仍会在达到 3 分钟后停止并返回（若无合格解则 timedOut=true）。
  const TIME_BUDGET_MS = 180000
  let timedOut = false
  const startColor = triangles.find(t=>t.id===startId)?.color
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  // 可选开关（默认关闭）：从全局覆写
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  const FULL_EXPAND = !!FLAGS.fullExpand
  const ENABLE_LB = !!FLAGS.enableLB
  const ENABLE_LOOKAHEAD = !!FLAGS.enableLookahead
  const ENABLE_INCREMENTAL = !!FLAGS.enableIncremental
  const ENABLE_BEAM = !!FLAGS.enableBeam
  const BEAM_WIDTH = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
  const ENABLE_BEST_FIRST = !!FLAGS.enableBestFirst
  const ENABLE_BRIDGE_FIRST = !!FLAGS.enableBridgeFirst
  // 自动调参：REV_BIFRONT_WEIGHT 在初始深度进行网格搜�?
  let REV_BIFRONT_WEIGHT = Number.isFinite(FLAGS?.revBifrontWeight) ? FLAGS.revBifrontWeight : 0.6
  const ENABLE_REV_TUNE = (FLAGS.enableRevBifrontTune !== false) && ENABLE_BEST_FIRST && !Number.isFinite(FLAGS?.revBifrontWeight)
  const REV_W_CANDIDATES = Array.isArray(FLAGS?.revBifrontCandidates) ? FLAGS.revBifrontCandidates : [0.4, 0.5, 0.6, 0.7, 0.8]
  const REV_TUNE_MAX_DEPTH = Number.isFinite(FLAGS?.revTuneDepthMax) ? FLAGS.revTuneDepthMax : 2
  const REV_TUNE_MIN_SAMPLES = Number.isFinite(FLAGS?.revTuneMinSamples) ? FLAGS.revTuneMinSamples : 30
  const REV_TUNE_TIMEOUT_MS = Number.isFinite(FLAGS?.revTuneTimeoutMs) ? FLAGS.revTuneTimeoutMs : 400
  let PRIO_VERSION = 0
  let revTuneFinalized = false
  let revTuneStats = new Map(REV_W_CANDIDATES.map(w => [w, { sum: 0, count: 0, max: -Infinity }]))
  const revTuneStartTs = Date.now()
  function maybeFinalizeRevTune() {
    if (!ENABLE_REV_TUNE || revTuneFinalized) return
    const elapsed = Date.now() - revTuneStartTs
    let totalCount = 0; for (const v of revTuneStats.values()) { totalCount += v.count }
    // 足量样本或达到超时阈值时选择权重
    const hasEnough = totalCount >= REV_TUNE_MIN_SAMPLES || elapsed >= REV_TUNE_TIMEOUT_MS
    if (!hasEnough) return
    if (totalCount <= 0) {
      revTuneFinalized = true
      try { onProgress?.({ phase: 'tune_rev_fallback', reason: 'no_samples', elapsedMs: elapsed }) } catch {}
      return
    }
    let bestW = REV_W_CANDIDATES[0]; let bestScore = -Infinity
    for (const w of REV_W_CANDIDATES) {
      const st = revTuneStats.get(w)
      if (st && st.count > 0) {
        const avg = st.sum / st.count
        if (avg > bestScore) { bestScore = avg; bestW = w }
      }
    }
    REV_BIFRONT_WEIGHT = bestW
    if (typeof self !== 'undefined') { try { self.SOLVER_FLAGS = Object.assign({}, self.SOLVER_FLAGS, { revBifrontWeight: bestW }) } catch {} }
    // 权重落锤后提升优先级版本号，触发堆顶惰性刷�?
    PRIO_VERSION++
    revTuneFinalized = true
    try { onProgress?.({ phase: 'tune_rev_selected', revW: bestW, samples: totalCount, elapsedMs: elapsed }) } catch {}
  }
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
  // 新增：DFS 进度上报时间间隔（毫秒）�? 表示禁用
  const PROGRESS_DFS_INTERVAL_MS = Number.isFinite(FLAGS?.progressDFSIntervalMs) ? Math.max(0, FLAGS.progressDFSIntervalMs) : 50
  // 稀有颜色与“准零扩张�?下界改进的过滤阈值（可调�?
  const RARE_FREQ_RATIO = Number.isFinite(FLAGS?.rareFreqRatio) ? FLAGS.rareFreqRatio : 0.03
  const RARE_FREQ_ABS = Number.isFinite(FLAGS?.rareFreqAbs) ? FLAGS.rareFreqAbs : 3
  const RARE_ALLOW_BRIDGE_MIN = Number.isFinite(FLAGS?.rareAllowBridgeMin) ? FLAGS.rareAllowBridgeMin : 2.0
  const RARE_ALLOW_GATE_MIN = Number.isFinite(FLAGS?.rareAllowGateMin) ? FLAGS.rareAllowGateMin : 1.0
  const MIN_DELTA_RATIO = Number.isFinite(FLAGS?.minDeltaRatio) ? FLAGS.minDeltaRatio : 0.02
  const LB_IMPROVE_MIN = Number.isFinite(FLAGS?.lbImproveMin) ? FLAGS.lbImproveMin : 1
  // 新增：质量采样与增益下降告警阈值（可通过 FLAGS 配置�?
  const QUALITY_SAMPLE_RATE = Number.isFinite(FLAGS?.qualitySampleRate) ? FLAGS.qualitySampleRate : 0.15
  const GAIN_DROP_WARN_RATIO = Number.isFinite(FLAGS?.gainDropWarnRatio) ? FLAGS.gainDropWarnRatio : 0.01

  function computeAdjAfterSize(color, curColors, regionSet){
    // 预演一步应�?color 后的新区域相邻颜色种类数（轻量版，无 RAG 依赖�?
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
  // 增量版：基于边界邻居集合快速估计相邻颜色种类数
  function computeAdjAfterFromBoundaryNeighbors(boundaryNeighbors, colorsArr){
    if (!boundaryNeighbors || boundaryNeighbors.length===0) return 0
    const set = new Set()
    for (const nb of boundaryNeighbors) {
      const nidx = idToIndex.get(nb); if (nidx==null) continue
      const tri = triangles[nidx]; const cc = colorsArr[nidx]
      if (!tri.deleted && cc && cc!=='transparent') set.add(cc)
    }
    return set.size
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
    // 估计打通到高扩张性组件的潜力（使�?RAG 缓存�?
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
      // 找到与新区域接触的组件集�?
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
  // 用户要求：取消所有尝试/节点上限，直到时间耗尽
  const maxNodes = Infinity
  const queueStates = [{ colors:startColors, region: new Set(region), steps: [] }]
  // 用堆替代全排序：根据 priority 维护最大堆（仅�?ENABLE_BEST_FIRST 下生效）
  const heapOn = ENABLE_BEST_FIRST
  const heap = queueStates
  const heapCmp = (a,b) => ((a?.priority ?? -Infinity) - (b?.priority ?? -Infinity))
  function heapSwap(i,j){ const t=heap[i]; heap[i]=heap[j]; heap[j]=t }
  function heapSiftUp(i){ while(i>0){ const p=((i-1)>>1); if(heapCmp(heap[i],heap[p])>0){ heapSwap(i,p); i=p } else break } }
  function heapSiftDown(i){ for(;;){ const l=i*2+1, r=l+1; let m=i; if(l<heap.length && heapCmp(heap[l],heap[m])>0) m=l; if(r<heap.length && heapCmp(heap[r],heap[m])>0) m=r; if(m!==i){ heapSwap(i,m); i=m } else break } }
  function queuePush(item){ if(!heapOn){ queueStates.push(item) } else { heap.push(item); heapSiftUp(heap.length-1) } }
  function queuePop(){
    if(!heapOn){ return queueStates.shift() }
    if(heap.length===0) return undefined
    for(;;){
      const top = heap[0]; if(!top) return undefined
      // 惰性刷新堆顶：若优先级版本落后，则用缓存基项与 revBoost 重算并下沉恢复堆�?
      if ((top.pver ?? 0) !== PRIO_VERSION) {
        if (Number.isFinite(top?.priorityBase) && Number.isFinite(top?.revBoost)) {
          top.priority = top.priorityBase + REV_BIFRONT_WEIGHT * top.revBoost
          top.pver = PRIO_VERSION
        }
        heapSiftDown(0)
        continue
      }
      const last = heap.pop(); if(heap.length>0){ heap[0]=last; heapSiftDown(0) }
      return top
    }
  }
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
  // 分支质量聚合（降低消息频率）：窗口内累计再随 search 事件上报
  let qualityAgg = { sum: 0, count: 0, max: -Infinity }
  // 边界数组对象池以降低 GC：复用临时数�?
  const BN_POOL_MAX = Number.isFinite(self?.SOLVER_FLAGS?.boundaryPoolMax) ? self.SOLVER_FLAGS.boundaryPoolMax : 64
  const boundaryArrayPool = []
  function releaseBoundaryArray(arr){ if (Array.isArray(arr) && boundaryArrayPool.length < BN_POOL_MAX){ arr.length = 0; boundaryArrayPool.push(arr) } }
  while(queueStates.length){
    // 高频兜底：避免因长时间不触发进度节流而越过总时限
    if ((nodes & 1023) === 0) {
      const nowTop = Date.now()
      if (nowTop - startTime > TIME_BUDGET_MS) { timedOut = true; break }
    }
    // 更高频的搜索阶段进度上报（按时间节流，而非固定节点间隔�?
    if (!lastSearchReportTs) { var lastSearchReportTs = startTime }
    const nowTsSearch = Date.now()
    if (nowTsSearch - lastSearchReportTs >= PROGRESS_DFS_INTERVAL_MS) {
      const pressureLocal = Math.min(1, queueStates.length / Math.max(1, maxNodes))
      // 动态节流：队列压力越高，进度上报间隔越长（减轻开销�?
      const throttleScale = 1 + 3 * pressureLocal
      lastSearchReportTs = nowTsSearch
      if (nowTsSearch - startTime > TIME_BUDGET_MS) { timedOut = true; break }
      await new Promise(r=>setTimeout(r,0))
      perf.queueMax = Math.max(perf.queueMax, queueStates.length)
      perf.depthMax = Math.max(perf.depthMax, maxDepth)
      const LOOKAHEAD_PRESSURE_MAX = Number.isFinite(self?.SOLVER_FLAGS?.lookaheadMaxPressure) ? self.SOLVER_FLAGS.lookaheadMaxPressure : 0.7
      const lookahead2On = (((!!self?.SOLVER_FLAGS?.enableLookaheadDepth2) || (Number.isFinite(stepLimit) && Array.isArray(palette) && palette.length <= 8 && !self?.SOLVER_FLAGS?.disableAutoLookaheadDepth2))) && (pressureLocal < LOOKAHEAD_PRESSURE_MAX)
      onProgress?.({ phase: 'search', nodes, queue: queueStates.length, solutions: solutions.length, elapsedMs: nowTsSearch - startTime, maxDepth, perf: { ...perf, qualityAgg }, pressure: pressureLocal, beamWidth: self.SOLVER_FLAGS?.beamWidth, lbImproveMin: self.SOLVER_FLAGS?.lbImproveMin, beamMin: self.SOLVER_FLAGS?.beamMin, lookahead2On })
      // search 窗口上报后重置质量聚合器，形成窗口聚�?
      qualityAgg = { sum: 0, count: 0, max: -Infinity }
      // 初始深度自动调参可能在时序上达到超时阈值，适时尝试落锤选择
      if (ENABLE_REV_TUNE && !revTuneFinalized) { try { maybeFinalizeRevTune() } catch {} }
      // 根据压力放大节流窗口（通过移动 lastSearchReportTs 来实现）
      lastSearchReportTs += Math.floor(PROGRESS_DFS_INTERVAL_MS * (throttleScale - 1))
    }
    const cur = queuePop(); nodes++
    const curColors = cur.colors
    // 剪枝：超过步数上限不再扩展（并上报原因）
    if (cur.steps.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
      const lbLocal = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, cur.region) : lowerBound(curColors)) : undefined
      try { onProgress?.({ phase:'branch_pruned', reason:'step_limit', depth: cur.steps.length, lb: lbLocal }) } catch {}
      // 释放当前节点的边界数组回对象�?
      if (Array.isArray(cur.boundaryNeighbors)) { try { releaseBoundaryArray(cur.boundaryNeighbors) } catch {} }
      continue
    }
    // LB 早停：若剩余下界超过可用步数则剪�?
    if (ENABLE_LB && Number.isFinite(stepLimit)){
      const lb = USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, cur.region) : lowerBound(curColors)
      if (cur.steps.length + lb > stepLimit) {
        try { onProgress?.({ phase:'branch_pruned', reason:'lb_exceed', depth: cur.steps.length, lb, maxAllow: stepLimit - cur.steps.length }) } catch {}
        // 释放当前节点的边界数组回对象�?
        if (Array.isArray(cur.boundaryNeighbors)) { try { releaseBoundaryArray(cur.boundaryNeighbors) } catch {} }
        continue
      }
    }
    if(isUniformSimple(curColors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))){
      // 若开启“先返回可行解”，立即返回当前路径（可能不是全局最短）
      if ((self.SOLVER_FLAGS?.returnFirstFeasible) && Number.isFinite(stepLimit)) {
        onProgress?.({ phase: 'solution', minSteps: cur.steps.length, solutions: 1, elapsedMs: Date.now() - startTime })
        // 释放当前节点的边界数组回对象�?
        if (Array.isArray(cur.boundaryNeighbors)) { try { releaseBoundaryArray(cur.boundaryNeighbors) } catch {} }
        return { paths: [cur.steps], minSteps: cur.steps.length, timedOut }
      }
      solutions.push(cur.steps)
      const minLen = solutions[0].length
      const sameLen = solutions.filter(s=>s.length===minLen)
      onProgress?.({ phase: 'solution', minSteps: minLen, solutions: sameLen.length, elapsedMs: Date.now() - startTime })
      // 释放当前节点的边界数组回对象�?
      if (Array.isArray(cur.boundaryNeighbors)) { try { releaseBoundaryArray(cur.boundaryNeighbors) } catch {} }
      if(sameLen.length>=maxBranches) break
      else continue
    }
    const regionSet = cur.region
    // 评估当前状态：尽量减少颜色种类，若相同则区域更大更�?
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

    // 邻接颜色与增益（优先使用增量边界缓存�?
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
    const tryColorsRaw = adjColors.size>0 ? [...adjColors] : palette
    const boundaryBefore = adjColors.size
    const basePreK = 6
    const depth = cur.steps.length
    const beamBase = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
    const beamDecay = Number.isFinite(FLAGS?.beamDecay) ? FLAGS.beamDecay : 0.85
    const beamMin = Number.isFinite(FLAGS?.beamMin) ? FLAGS.beamMin : 4
    const beamMax = Number.isFinite(FLAGS?.beamMax) ? FLAGS.beamMax : 64
    const pressure = Math.min(1, (Array.isArray(queueStates) ? queueStates.length : 0) / Math.max(1, maxNodes))
    const pressureScale = ENABLE_BEAM ? Math.max(0.6, 1.0 - 0.5*pressure) : 1.0
    const dynamicWidth = ENABLE_BEAM ? Math.min(beamMax, Math.max(beamMin, Math.floor(beamBase * Math.pow(beamDecay, depth) * pressureScale))) : Math.min(beamMax, beamBase)
    // 深度降级（fullExpand）时：不截断候选颜色，确保之前被剪除的分支也会被计算
    const preK = FULL_EXPAND ? tryColorsRaw.length : (ENABLE_BEAM ? Math.min(dynamicWidth, basePreK) : basePreK)
    const LOOKAHEAD_PRESSURE_MAX = Number.isFinite(FLAGS?.lookaheadMaxPressure) ? FLAGS.lookaheadMaxPressure : 0.7
    const ENABLE_LOOKAHEAD2_LOCAL = ((!!FLAGS.enableLookaheadDepth2) || (Number.isFinite(stepLimit) && Array.isArray(palette) && palette.length <= 8 && !FLAGS?.disableAutoLookaheadDepth2)) && (pressure < LOOKAHEAD_PRESSURE_MAX)
    const prelim = tryColorsRaw.map(c=>{
      const g = (gain.get(c)||0)
      const score0 = g*3 + getColorBiasRAG(c)
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
      // 非面积扩张潜力：边界同色种子数量 + 种子连通性（分量越少越好�?
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
    let limitTry = FULL_EXPAND ? tryColorsRaw.length : (ENABLE_BEAM ? Math.max(beamMin, Math.floor(dynamicWidth)) : 8)
    const prevLB = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, regionSet) : lowerBound(curColors)) : 0
    const BF_W = Number.isFinite(self?.SOLVER_FLAGS?.bifrontWeight) ? self.SOLVER_FLAGS.bifrontWeight : 2.0
    let scored = prelim
      .map(({c, gain})=>{ 
        const pot=(enlargePotential.get(c)||0); 
        const saddle=(saddlePotential.get(c)||0);
        let score=gain*3 + pot*2 + saddle*BF_W + getColorBiasRAG(c); 
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
              // 计算一步后的临时新区域（在颜色 c 内），用于严格下�?
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
        if (ENABLE_LOOKAHEAD2_LOCAL){
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
            .map(({c2,g})=>({ c2, score0: g*3 + getColorBiasRAG(c2) }))
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
      let nextBoundaryNeighbors
      const nextSteps = [...cur.steps, color]
      if (nextSteps.length > maxDepth) maxDepth = nextSteps.length
        if (nextSteps.length <= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
          // 过滤：零扩张候选（应用颜色后区域未增长�?
          const delta = newRegion.size - regionSet.size
          if (!FULL_EXPAND && ENABLE_ZERO_FILTER && delta <= 0) {
            perf.filteredZero++
            try { onProgress?.({ phase:'branch_pruned', reason:'zero_expand', step: nextSteps.length, color, delta, regionSize: regionSet.size }) } catch {}
            continue
          }
          // 准零扩张：相对增长过小则跳过（避免“几乎没用”的动作�?
          const deltaRatio = delta / Math.max(1, regionSet.size)
          if (!FULL_EXPAND && deltaRatio < MIN_DELTA_RATIO) {
            try { onProgress?.({ phase:'branch_pruned', reason:'delta_small', step: nextSteps.length, color, deltaRatio, regionSize: regionSet.size }) } catch {}
            continue
          }
          // 稀有颜色过滤：全局出现很少且桥接价值不显著时跳过（使用邻接后种类数作为桥接代理�?
          const freq = (colorCount.get(color) || 0)
          const rareTh = Math.max(RARE_FREQ_ABS, Math.floor(triangles.length * RARE_FREQ_RATIO))
          if (freq < rareTh) {
            const { bridgePotential, gateScore } = computeBridgePotential(color, nextColors, newRegion)
            const adjAfter = computeAdjAfterSize(color, nextColors, newRegion)
            // 根据剩余步数预算自适配稀有阈值（低预算更宽松�?
            let RARE_BRIDGE_MIN_EFF = RARE_ALLOW_BRIDGE_MIN
            let RARE_GATE_MIN_EFF = RARE_ALLOW_GATE_MIN
            if (Number.isFinite(stepLimit)) {
              const prevLBLocalRare = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, regionSet) : lowerBound(curColors)) : 0
              const slack0 = stepLimit - (nextSteps.length + prevLBLocalRare)
              const slackNorm = Math.max(0, Math.min(1, slack0 / Math.max(1, stepLimit)))
              const relaxScale = Number.isFinite(self?.SOLVER_FLAGS?.rareRelaxScale) ? self.SOLVER_FLAGS.rareRelaxScale : 0.5
              const coeff = (1 - relaxScale) + relaxScale * slackNorm
              RARE_BRIDGE_MIN_EFF = Math.max(1, Math.floor(RARE_ALLOW_BRIDGE_MIN * coeff))
              RARE_GATE_MIN_EFF = Math.max(1, Math.floor(RARE_ALLOW_GATE_MIN * coeff))
            }
            if (!FULL_EXPAND && bridgePotential < RARE_BRIDGE_MIN_EFF && gateScore < RARE_GATE_MIN_EFF && adjAfter < RARE_BRIDGE_MIN_EFF) {
              try { onProgress?.({ phase:'branch_pruned', reason:'rare_no_bridge_gate', step: nextSteps.length, color, adjAfter, bridgePotential, gateScore, rareEff:{ bridge: RARE_BRIDGE_MIN_EFF, gate: RARE_GATE_MIN_EFF } }) } catch {}
              continue
            }
          }
          // 构建下一状态的边界邻居缓存（可选）
          if (ENABLE_INCREMENTAL && !nextBoundaryNeighbors) {
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
          let baseScore = (gain.get(color)||0)*3 + (enlargePotential.get(color)||0)*2 + getColorBiasRAG(color)
          // 稀有颜�?hard guard：频次极低且增益<=0时直接拒�?
          {
            const freqCount = (FREQ.get(color) || 0)
            const rareTh = Math.max(RARE_FREQ_ABS, Math.floor(triangles.length * RARE_FREQ_RATIO))
            const isRare = freqCount < rareTh
            const g0 = (gain.get(color) || 0)
            if (!FULL_EXPAND && isRare && g0 <= 0) {
              try { onProgress?.({ phase:'branch_pruned', reason:'rare_hard_guard', step: nextSteps.length, color, gain: g0, freq: freqCount }) } catch {}
              continue
            }
          }
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
        let LB_MIN_EFF = LB_IMPROVE_MIN
        if (Number.isFinite(stepLimit)) {
          const slack0 = stepLimit - (nextSteps.length + prevLBLocal)
          const slackNorm = Math.max(0, Math.min(1, slack0 / Math.max(1, stepLimit)))
          const relax = Number.isFinite(self?.SOLVER_FLAGS?.lbImproveRelaxScale) ? self.SOLVER_FLAGS.lbImproveRelaxScale : 0.5
          // S 曲线放松：使�?smoothstep(slackNorm) 替代线�?
          const s = slackNorm * slackNorm * (3 - 2 * slackNorm)
          const coeff = (1 - relax) + relax * s
          LB_MIN_EFF = Math.max(1, Math.floor(LB_IMPROVE_MIN * coeff))
        }
        if (!FULL_EXPAND && (prevLBLocal - childLB) < LB_MIN_EFF) {
          try { onProgress?.({ phase:'branch_pruned', reason:'lb_improve_small', step: nextSteps.length, color, prevLB: prevLBLocal, childLB, improve: (prevLBLocal - childLB), lbMinEff: LB_MIN_EFF }) } catch {}
          continue
        }
        const improve = Math.max(0, prevLBLocal - childLB)
        if (improve <= 0) perf.lbHist.improve0++
        else if (improve <= 2) perf.lbHist.improve1_2++
        else if (improve <= 5) perf.lbHist.improve3_5++
        else perf.lbHist.improve6p++
      }
          const SLACK_WEIGHT = Number.isFinite(self?.SOLVER_FLAGS?.slackWeight) ? self.SOLVER_FLAGS.slackWeight : 1.0
          const GAIN_WEIGHT = Number.isFinite(self?.SOLVER_FLAGS?.gainWeight) ? self.SOLVER_FLAGS.gainWeight : 1.0
          const BIFRONT_PRIO_WEIGHT = Number.isFinite(self?.SOLVER_FLAGS?.bifrontPrioWeight) ? self.SOLVER_FLAGS.bifrontPrioWeight : 0.4
          // REV_BIFRONT_WEIGHT 使用顶部可调变量（自动调参后更新�?
          const slackChild = Number.isFinite(stepLimit) ? Math.max(0, stepLimit - (nextSteps.length + childLB)) : 0
          const slackNormForPrio = Number.isFinite(stepLimit) ? Math.max(0, Math.min(1, slackChild / Math.max(1, stepLimit))) : 0
          const adjAfterForPrio = (ENABLE_INCREMENTAL && nextBoundaryNeighbors)
            ? computeAdjAfterFromBoundaryNeighbors(nextBoundaryNeighbors, nextColors)
            : computeAdjAfterSize(color, nextColors, newRegion)
          // 轻量近双向：估计边界外到区域的可桥接序列长度（近似为边界颜色种类数）
          let boundaryColorKinds = 0
          {
            const bcolors = new Set()
            for(const tid2 of newRegion){
              const idx2=idToIndex.get(tid2)
              for(const nb2 of neighbors[idx2]){
                const nidx2=idToIndex.get(nb2); if(nidx2==null) continue
                const tri2=triangles[nidx2]; const c2=nextColors[nidx2]
                if(c2!==color && c2 && c2!=='transparent' && !tri2.deleted){ bcolors.add(c2) }
              }
            }
            boundaryColorKinds = bcolors.size
          }
          const revBoost = (Number.isFinite(stepLimit) && boundaryColorKinds>0 && boundaryColorKinds <= slackChild)
            ? Math.min(1, (slackChild - boundaryColorKinds) / Math.max(1, stepLimit))
            : 0
          const priorityBase = baseScore - childLB * 2 + SLACK_WEIGHT * slackNormForPrio + GAIN_WEIGHT * deltaRatio + BIFRONT_PRIO_WEIGHT * adjAfterForPrio
          // 初始深度网格调参：对候选权重评估分支质量并累计统计（自适应采样�?
          if (ENABLE_REV_TUNE && !revTuneFinalized && nextSteps.length <= REV_TUNE_MAX_DEPTH) {
            const pressureLocalBranch = Math.min(1, (heap?.length ?? queueStates.length) / Math.max(1, maxNodes))
            const baseRateTune = Number.isFinite(self?.SOLVER_FLAGS?.qualitySampleRate) ? self.SOLVER_FLAGS.qualitySampleRate : 0.15
            const rateTune = Math.min(1, Math.max(0.03, baseRateTune * (1 - 0.7*pressureLocalBranch) * (nextSteps.length <= 2 ? 1.2 : 1.0)))
            for (const w of REV_W_CANDIDATES) {
              const pw = priorityBase + w * revBoost
              const st = revTuneStats.get(w); if (st) { st.sum += pw; st.count++; st.max = Math.max(st.max, pw) }
              if (onProgress && Math.random() < rateTune) {
                try { onProgress({ phase:'branch_quality', step: nextSteps.length, color, delta, deltaRatio, lb: childLB, priority: pw, adjAfter: adjAfterForPrio, slack: Number.isFinite(stepLimit) ? slackChild : undefined, revW: w, tuneRev: true }) } catch {}
              }
            }
          }
          const priority = priorityBase + REV_BIFRONT_WEIGHT * revBoost
          // 分支质量聚合与自适应采样：压力高降采样，压力低适度升采�?
          try {
            if (onProgress) {
              const pressureLocalBranch = Math.min(1, (heap?.length ?? queueStates.length) / Math.max(1, maxNodes))
              const baseRate = Number.isFinite(self?.SOLVER_FLAGS?.qualitySampleRate) ? self.SOLVER_FLAGS.qualitySampleRate : 0.15
              const qualityRateLocal = Math.min(1, Math.max(0.02, baseRate * (1 - 0.7*pressureLocalBranch) * (nextSteps.length <= 2 ? 1.2 : 1.0)))
              // 聚合统计（全部累加），消息按采样率发�?
              qualityAgg.sum += priority; qualityAgg.count++; qualityAgg.max = Math.max(qualityAgg.max, priority)
              if (Math.random() < qualityRateLocal) {
                const adjAfterQ = adjAfterForPrio
                onProgress({ phase:'branch_quality', step: nextSteps.length, color, delta, deltaRatio, lb: childLB, priority, adjAfter: adjAfterQ, slack: Number.isFinite(stepLimit) ? slackChild : undefined })
              }
            }
          } catch {}
          queuePush({ colors: nextColors, region: newRegion, steps: nextSteps, boundaryNeighbors: nextBoundaryNeighbors, priority, priorityBase, revBoost, pver: PRIO_VERSION })
          perf.enqueued++
          perf.expanded += Math.max(0, delta)
        }
    }
    // 释放当前节点的边界数组回对象池（常规路径�?
    if (Array.isArray(cur.boundaryNeighbors)) { try { releaseBoundaryArray(cur.boundaryNeighbors) } catch {} }
    if (ENABLE_BEST_FIRST) {
      // 使用堆维护顺序，无需全排�?
    }
  }
  if(solutions.length===0){
    // 若设置了步数上限，使用深度受�?DFS 回退以保证统一解（在上限内�?
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
          let s = (gain.get(c)||0)*3 + getColorBiasRAG(c)
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
          // 禁止短周期振荡：A -> B -> A（极容易出现“黄↔橙”空转）
          if (steps.length >= 2 && color === steps[steps.length - 2]) continue
          const nextColors = colors.slice(); for(const id of regionSet) nextColors[idToIndex.get(id)] = color
          const key = keyFromColors(nextColors); if(seen.has(key)) continue; seen.add(key)
          const q=[...regionSet]; const newRegion=new Set([...regionSet]); const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } } }
          // 关键剪枝：禁止“零扩张/几乎不扩张”的步（否则会浪费步数做无意义换色）
          const delta = newRegion.size - regionSet.size
          if (delta <= 0) {
            try { onProgress?.({ phase:'branch_pruned', reason:'zero_expand_dfs', step: steps.length + 1, color, delta, regionSize: regionSet.size }) } catch {}
            continue
          }
          const deltaRatio = delta / Math.max(1, regionSet.size)
          if (Number.isFinite(MIN_DELTA_RATIO) && deltaRatio < MIN_DELTA_RATIO) {
            try { onProgress?.({ phase:'branch_pruned', reason:'delta_small_dfs', step: steps.length + 1, color, delta, deltaRatio, regionSize: regionSet.size }) } catch {}
            continue
          }
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
    // 否则（仅当步数上限为无限时）：保留贪心近似路径用于参�?
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

// 严格 A* 最短路（可选开�?strictMode）：可采纳下�?+ 转置表剪�?
async function StrictAStarMinSteps(triangles, startId, palette, onProgress, stepLimit=Infinity){
  const startTime = Date.now()
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  // 固定总预算 3 分钟（避免 strict 子搜索用更短预算导致提前退出）
  const TIME_BUDGET_MS = 180000
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
    // 全局颜色离散下界（可采纳�?
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
    // 边界颜色下界（当前边界上的不同颜色数�?
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
    // 桥接下界（结构化项）：当前边界上的不同颜色数的保守近�?
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
    // 时间预算与进度上�?
    const nowTs = Date.now()
    if (nowTs - startTime > TIME_BUDGET_MS) { timedOut = true; break }
    if (REPORT_INTERVAL_MS<=0 || (nowTs - lastReport) >= REPORT_INTERVAL_MS){
      lastReport = nowTs
      try { onProgress?.({ phase:'strict_astar', nodes, open: open.length, depth: maxDepth, elapsedMs: nowTs - startTime }) } catch {}
      await new Promise(r=>setTimeout(r,0))
    }
    // �?f 最小状�?
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
      const boundarySet = new Set()
      while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!tri) continue; if(tri.deleted || tri.color==='transparent') continue; const cnb = nextColors[nidx]; if(cnb===color){ if(!visited2[nidx]){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } } else { boundarySet.add(nb) } } }
      const nextBoundaryNeighbors = Array.from(boundarySet)
      const HEUR_NAME = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.heuristicName : null
      const HEUR = HEUR_NAME ? getHeuristic(HEUR_NAME) : null
      const lbStrict = lowerBoundStrict(nextColors, newRegion)
      const h = HEUR ? (HEUR.isLayered ? HEUR({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion, lbStrict) : Math.max(lbStrict, HEUR({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion))) : lbStrict
      if (Number.isFinite(stepLimit) && (g + h) > stepLimit) { continue }
      const f = g + h
      seenBestG.set(key, g)

      open.push({ colors: nextColors, region: newRegion, steps: [...cur.steps, color], g, f, boundaryNeighbors: nextBoundaryNeighbors })
    }
  }
  // 若失败或超时：返回空路径，交由上层处�?
  return { paths: [], minSteps: 0, timedOut }
}

// IDA*（迭代加�?A*）：使用强下�?h（LB_colors/LB_frontier/LB_area），并结�?Transposition Table�?4�?Zobrist）去�?
async function StrictIDAStarMinSteps(triangles, startId, palette, onProgress, stepLimit=Infinity){
  const startTime = Date.now()
  // �?A* 保持一致的时间预算与进度间�?
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  // 固定总预算 3 分钟（用户要求）
  const TIME_BUDGET_MS = 180000
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
  // Zobrist 64位哈希（颜色 + 区域形状�?
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

  // 全局 TT：跨迭代保留 min(g) �?min(f)，支持更强复�?
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
    // 进度与时间预�?
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
    // 下界�?f �?
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
    // 跨迭代复用：若已见过更小�?f 或更小的 g，则也可剪枝
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
    // 收集边界邻居（与当前区域相邻且不同色�?
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
      for(const s of seeds){ if(visitedS.has(s)) continue; const q=[s]; visitedS.add(s); while(q.length){ const u=q.shift(); const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx==null) continue; if(!visitedS.has(v) && colors[vIdx]===c){ visitedS.add(v); q.push(v) } } }
      }
      compSizes.sort((a,b)=>b-a)
      saddlePotential.set(c, compSizes.length)
    }
    function computeAdjAfterSize(c, colors, regionSet){
      const tmp = colors.slice()
      for(const id of regionSet){ tmp[idToIndex.get(id)] = c }
      const newRegion = new Set([...regionSet])
      const q=[...regionSet]
      const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
      while(q.length){
        const tid=q.shift(); const idx=idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx=idToIndex.get(nb); if(nidx==null) continue
          const tri=triangles[nidx]; const cc=tmp[nidx]
          if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && cc===c){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) }
        }
      }
      const adjSet = new Set()
      for(const tid2 of newRegion){
        const idx2=idToIndex.get(tid2)
        for(const nb2 of neighbors[idx2]){
          const nidx2=idToIndex.get(nb2); if(nidx2==null) continue
          const tri2=triangles[nidx2]; const cc2=tmp[nidx2]
          if(!tri2.deleted && cc2 && cc2!=='transparent' && cc2!==c){ adjSet.add(cc2) }
        }
      }
      return adjSet.size
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
      // 新区域扩张（颜色相同�?
      const q=[...regionSet]; const newRegion=new Set([...regionSet]); const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
      const boundarySet = new Set()
      while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!tri) continue; if(tri.deleted || tri.color==='transparent') continue; const cnb = nextColors[nidx]; if(cnb===color){ if(!visited2[nidx]){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } } else { boundarySet.add(nb) } } }
      const gNext = g + 1
      const nextBoundaryNeighbors = Array.from(boundarySet)
      const HEUR_NAME2 = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.heuristicName : null
      const HEUR2 = HEUR_NAME2 ? getHeuristic(HEUR_NAME2) : null
      const lbStrictNext = lowerBoundStrict(nextColors, newRegion)
      const hNext = HEUR2 ? (HEUR2.isLayered ? HEUR2({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion, lbStrictNext) : Math.max(lbStrictNext, HEUR2({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion))) : lbStrictNext
      const fNext = gNext + hNext
      if (Number.isFinite(stepLimit) && fNext > stepLimit) { minNextBound = Math.min(minNextBound, fNext); continue }
      nodes++
      maxDepth = Math.max(maxDepth, path.length+1)
      perf.expanded++

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
  // 计算总时限：固定 3 分钟（用户要求：没出合格解且时间没到就必须继续算）
  const TIME_BUDGET_MS = 180000
  let timedOut = false
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  // 用户指定步数上限时，必须严格满足；默认不允许自动放宽（否则会产生“上限5却返回6步”的不合格解）
  const ALLOW_STEP_LIMIT_RELAX = (FLAGS?.allowStepLimitRelax === true)
  const requiredStepLimit = stepLimit
  // 允许“超一步”用于更容易先找到一个解，再尝试优化压回步数上限（但绝不作为合格解直接返回）
  // 默认关闭：仅由前端分配的 1/4 “近似组”线程开启
  const ALLOW_NEAR_MISS = (FLAGS?.allowNearMissStep === true)
  const NEAR_MISS_EXTRA = Number.isFinite(FLAGS?.nearMissExtraSteps) ? Math.max(0, Math.min(2, FLAGS.nearMissExtraSteps)) : 1
  const acceptStepLimit = requiredStepLimit
  const exploreStepLimit = (Number.isFinite(requiredStepLimit) && ALLOW_NEAR_MISS) ? (requiredStepLimit + NEAR_MISS_EXTRA) : requiredStepLimit
  let stepLimitLocal = exploreStepLimit
  let bestNearMiss = null // 优先：len = acceptStepLimit+1
  let bestNearMiss2 = null // 备选：len = acceptStepLimit+2（尽量压回 +1）
  // 动态束�?阈值调度参�?
  const SCHED_INTERVAL_MS = Number.isFinite(FLAGS?.dynamicScheduleIntervalMs) ? Math.max(500, FLAGS.dynamicScheduleIntervalMs) : 2500
  const ADJUST_ON_NO_PROGRESS = (FLAGS?.dynamicBeamAdjustOnNoBestUpdate !== false)
  let lastBestUpdateTs = startTime
  const baseBeamWidth = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
  const baseLbImproveMin = Number.isFinite(FLAGS?.lbImproveMin) ? FLAGS.lbImproveMin : 1
  const baseBeamMin = Number.isFinite(FLAGS?.beamMin) ? FLAGS.beamMin : 4
  const beamMax = Number.isFinite(FLAGS?.beamMax) ? FLAGS.beamMax : 64
  const beamScheduleTargets = Array.isArray(FLAGS?.beamScheduleTargets) ? FLAGS.beamScheduleTargets : [32, 40, 48]
  let beamScheduleIdx = 0
  // 预处理（components）阶段：不允许因为 20s 之类的配置而提前截断（会导致搜索空间不完整）
  const PREPROC_TIME_BUDGET_MS = TIME_BUDGET_MS
  const PROG_COMP_INTERVAL = Number.isFinite(FLAGS?.progressComponentsIntervalMs) ? Math.max(0, FLAGS.progressComponentsIntervalMs) : 100
  const PROGRESS_DFS_INTERVAL_MS = Number.isFinite(FLAGS?.progressDFSIntervalMs) ? Math.max(0, FLAGS.progressDFSIntervalMs) : 50
  const USE_DFS_FIRST = !!FLAGS.useDFSFirst
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  function lowerBoundStrictLocalAuto(colors, regionSet, startIdLocal){
    let activeCount = 0
    const colorFreq = new Map()
    for(let i=0;i<triangles.length;i++){
      const t = triangles[i]; const c = colors[i]
      if(!t.deleted && c && c!=='transparent'){
        activeCount++
        colorFreq.set(c, (colorFreq.get(c)||0)+1)
      }
    }
    const lbColors = Math.max(0, colorFreq.size - 1)
    const rc = colors[idToIndex.get(startIdLocal)]
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
      // 若预处理阶段超时，在构建当前分量时也立即退�?
      if ((Date.now() - startTime) > PREPROC_TIME_BUDGET_MS) {
        break
      }
      const cid=q.shift()
      const idx=idToIndex.get(cid)
      const tri=triangles[idx]
      if(tri.deleted || tri.color==='transparent' || tri.color!==color) continue
      comp.push(cid)
      for(const nb of neighbors[idx]){ if(!visited.has(nb)){ const nidx=idToIndex.get(nb); const tri2=triangles[nidx]; if(!tri2.deleted && tri2.color!=='transparent' && tri2.color===color){ visited.add(nb); q.push(nb) } } }

      // 组件构建中的细粒度进度（时间节流），包含当前分量大小与颜�?
      if (onProgress) {
        const nowTs = Date.now()
        if (PROG_COMP_INTERVAL <= 0 || (nowTs - compLastTs) >= PROG_COMP_INTERVAL) {
          compLastTs = nowTs
          onProgress({ phase:'components_build', count: components.length, compSize: comp.length, color, elapsedMs: nowTs - startTime })
          // 让出事件循环以便主线�?UI 刷新
          await new Promise(r=>setTimeout(r,0))
        }
      }
    }
    if(comp.length>0){
      components.push({ color, ids: comp, startId: comp[0], size: comp.length })
      const nowTs = Date.now()
      // 更频繁的组件阶段进度：每个组件打点，并附�?elapsedMs；可选时间节�?
      if (onProgress) {
        if (PROG_COMP_INTERVAL <= 0 || (nowTs - compLastTs) >= PROG_COMP_INTERVAL) {
          compLastTs = nowTs
          onProgress({ phase:'components', count: components.length, elapsedMs: nowTs - startTime })
          // 让出事件循环，确保主线程能及时刷新显�?
          await new Promise(r=>setTimeout(r,0))
        } else {
          onProgress({ phase:'components', count: components.length, elapsedMs: nowTs - startTime })
        }
      }
    }
  }
  // 预处理阶段结束：无论耗时长短，输出一次总结打点，便于判定阶段完�?
  {
    const nowTs = Date.now()
    const largest = components.length>0 ? components.reduce((m,c)=> Math.max(m, c.size||0), 0) : 0
    const summary = { phase:'components_done', count: components.length, largest, elapsedMs: nowTs - startTime }
    try { onProgress?.(summary) } catch {}
  }
  // 基于预处理分量构建颜色偏置（RAG近似）：按颜色的分量数量取偏置的倒数
  const COLOR_COMP_COUNT = new Map()
  for (const comp of components) {
    const c = comp.color
    if (c) COLOR_COMP_COUNT.set(c, (COLOR_COMP_COUNT.get(c)||0)+1)
  }
  const getColorBiasRAG = (c)=> 1 / Math.max(1, (COLOR_COMP_COUNT.get(c)||1))
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
        // 优先处理高离散度颜色的桥接分量，其次按分量大小降�?
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

  // 为每个颜色分量生成多个候选起点（边界更“桥接”的点更容易出解）
  const idToIndexGlobal = idToIndex
  const neighborsGlobal = neighbors
  function boundaryScoreForId(id){
    try {
      const idx = idToIndexGlobal.get(id)
      if (idx==null) return -Infinity
      const t = triangles[idx]
      if (!t || t.deleted || t.color==='transparent') return -Infinity
      const c0 = t.color
      let score = 0
      for (const nb of (neighborsGlobal[idx] || [])) {
        const nidx = idToIndexGlobal.get(nb)
        if (nidx==null) continue
        const tn = triangles[nidx]
        if (!tn || tn.deleted || tn.color==='transparent') continue
        if (tn.color !== c0) score++
      }
      return score
    } catch { return -Infinity }
  }
  function pickStartCandidates(comp, k=4){
    const ids = comp?.ids || []
    if (!Array.isArray(ids) || ids.length===0) return [comp?.startId].filter(x=>x!=null)
    const preferred = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.preferredStartId : null
    const out = []
    const seen = new Set()
    function push(id){ if(id!=null && !seen.has(id)){ seen.add(id); out.push(id) } }
    // 1) 优先起点
    if (preferred!=null && ids.includes(preferred)) push(preferred)
    // 2) 原始 startId
    push(comp.startId)

    // 3) 采样一部分 id 做边界评分，取 top-k
    const SAMPLE_MAX = 220
    const sample = []
    if (ids.length <= SAMPLE_MAX) {
      for (const id of ids) sample.push(id)
    } else {
      // 均匀采样 + 少量随机
      const step = Math.max(1, Math.floor(ids.length / 180))
      for (let i=0;i<ids.length && sample.length<180;i+=step) sample.push(ids[i])
      for (let i=0;i<40;i++){
        const rid = ids[Math.floor(Math.random()*ids.length)]
        if (rid!=null) sample.push(rid)
      }
    }
    const scored = []
    for (const id of sample) {
      const s = boundaryScoreForId(id)
      if (Number.isFinite(s)) scored.push({ id, s })
    }
    scored.sort((a,b)=> b.s - a.s)
    for (const it of scored.slice(0, Math.max(1, k))) push(it.id)
    return out
  }
  // 预计算候选起点（默认 4 个），后续会随降级扩大
  for (const comp of components) {
    comp.startCandidates = pickStartCandidates(comp, 4)
  }
  // 若指定了优先起点，则将对应分量置�?
  try {
    const preferred = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.preferredStartId : null
    if (preferred!=null) {
      const idx = components.findIndex(c=>c.startId===preferred)
      if (idx>0) { const [c] = components.splice(idx,1); components.unshift(c) }
    }
  } catch {}
  components.sort((a,b)=>b.size-a.size)
  let best={ startId:null, minSteps: Infinity, paths: [] }

  // 重试/降级循环：无上限（直到 3 分钟耗尽）
  const baseFlagsSnapshot = { ...(self.SOLVER_FLAGS || {}) }
  let retry = 0

  // Phase A: 快速种子阶段（MCTS / SAT 宏规划）——目标：尽快拿到任何“统一颜色”的合格解
  // 注：严格线程可以通过 flags.skipSeedPhase 跳过该阶段，把预算全部留给严格证明搜索。
  try {
    if (FLAGS?.skipSeedPhase) {
      try { onProgress?.({ phase:'seed_skipped', reason:'skipSeedPhase', elapsedMs: Date.now() - startTime }) } catch {}
    } else {
      const remaining0 = TIME_BUDGET_MS - (Date.now() - startTime)
      const seedBudget = Math.max(0, Math.min(25000, Math.floor(remaining0 * 0.25)))
      if (seedBudget >= 3000) {
        const seedStartTs = Date.now()
        const TOP_COMPS = Math.min(4, components.length)
        for (let ci=0; ci<TOP_COMPS; ci++){
          if (Date.now() - seedStartTs > seedBudget) break
          const comp = components[ci]
          const candList = (comp?.startCandidates || [comp?.startId]).slice(0, 2)
          for (const sid of candList){
            if (sid==null) continue
            if (Date.now() - seedStartTs > seedBudget) break
            try { onProgress?.({ phase:'seed_start', algo:'mcts/sat', startId: sid, elapsedMs: Date.now() - startTime }) } catch {}

          // SAT 宏规划（可选）：依赖后端服务，失败则忽略
          if (FLAGS?.enableSATPlanner) {
            try {
              const plan = await satMacroColorPlan(triangles, sid, palette)
              const order = Array.isArray(plan?.order) ? plan.order.filter(Boolean) : []
              if (!order.length) {
                try {
                  onProgress?.({
                    phase: 'sat_empty',
                    startId: sid,
                    note: 'no_macro_order (check SAT backend /api/sat/set-cover)',
                    elapsedMs: Date.now() - startTime
                  })
                } catch {}
              }
              if (order.length) {
                // 直接验证宏序列是否能统一（很快）
                const baseColors = triangles.map(t=>t.color)
                const idToIndexL = idToIndex
                const neighborsL = neighbors
                const applyOne = (colorsArr, color)=>{
                  const startColor = colorsArr[idToIndexL.get(sid)]
                  if (color===startColor) return colorsArr
                  const visited=new Set([sid]); const q=[sid]; const region=[]
                  while(q.length){ const id=q.shift(); const idx=idToIndexL.get(id); if(colorsArr[idx]!==startColor) continue; region.push(id); for(const nb of neighborsL[idx]){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } } }
                  const next = colorsArr.slice()
                  for(const id of region){ next[idToIndexL.get(id)] = color }
                  return next
                }
                let colorsNow = baseColors.slice()
                const path = []
                for (const c of order) { colorsNow = applyOne(colorsNow, c); path.push(c) }
                // 验证统一性
                let first=null; let ok=true
                for(let i=0;i<triangles.length;i++){ const t=triangles[i]; const c=colorsNow[i]; if(t.deleted || !c || c==='transparent') continue; if(first===null) first=c; else if(c!==first){ ok=false; break } }
                if (ok && first!==null) {
                  // 压缩修复（安全）
                  const repaired = await localRepair(triangles, palette, sid, path, (p)=>{ try{ onProgress?.({ ...p, phase: p?.phase || 'local_repair' }) } catch {} })
                  const finalPath = repaired?.path || path
                  if (Number.isFinite(acceptStepLimit)) {
                    if (finalPath.length <= acceptStepLimit) {
                      return { bestStartId: sid, paths: [finalPath], minSteps: finalPath.length, timedOut: false }
                    }
                    if (ALLOW_NEAR_MISS && finalPath.length === acceptStepLimit + 1) {
                      try { onProgress?.({ phase:'near_miss', source:'seed', startId: sid, len: finalPath.length, stepLimit: acceptStepLimit }) } catch {}
                    } else if (finalPath.length > (ALLOW_NEAR_MISS ? (acceptStepLimit + 1) : acceptStepLimit)) {
                      try { onProgress?.({ phase:'seed_reject', reason:'step_limit', startId: sid, len: finalPath.length, stepLimit: acceptStepLimit }) } catch {}
                    }
                  } else {
                    return { bestStartId: sid, paths: [finalPath], minSteps: finalPath.length, timedOut: false }
                  }
                }
              }
            } catch (e) {
              try {
                onProgress?.({
                  phase: 'sat_error',
                  startId: sid,
                  error: String(e?.message || e),
                  elapsedMs: Date.now() - startTime
                })
              } catch {}
            }
          }

          // MCTS rollout：时间切片
          const slice = Math.max(800, Math.min(6000, Math.floor(seedBudget / (TOP_COMPS*2))))
          const m = await mctsSolve(triangles, sid, palette, slice, (p)=>{
            try { onProgress?.({ ...p, phase: p?.phase || 'mcts_rollout', startId: sid }) } catch {}
          })
          const path0 = Array.isArray(m?.path) ? m.path.filter(Boolean) : []
          if (path0.length) {
            // 验证统一性
            const baseColors = triangles.map(t=>t.color)
            const idToIndexL = idToIndex
            const neighborsL = neighbors
            const applyOne = (colorsArr, color)=>{
              const startColor = colorsArr[idToIndexL.get(sid)]
              if (color===startColor) return colorsArr
              const visited=new Set([sid]); const q=[sid]; const region=[]
              while(q.length){ const id=q.shift(); const idx=idToIndexL.get(id); if(colorsArr[idx]!==startColor) continue; region.push(id); for(const nb of neighborsL[idx]){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } } }
              const next = colorsArr.slice()
              for(const id of region){ next[idToIndexL.get(id)] = color }
              return next
            }
            let colorsNow = baseColors.slice()
            for (const c of path0) colorsNow = applyOne(colorsNow, c)
            let first=null; let ok=true
            for(let i=0;i<triangles.length;i++){ const t=triangles[i]; const c=colorsNow[i]; if(t.deleted || !c || c==='transparent') continue; if(first===null) first=c; else if(c!==first){ ok=false; break } }
            if (ok && first!==null) {
              const repaired = await localRepair(triangles, palette, sid, path0, (p)=>{ try{ onProgress?.({ ...p, phase: p?.phase || 'local_repair' }) } catch {} })
              const finalPath = repaired?.path || path0
              if (Number.isFinite(acceptStepLimit)) {
                if (finalPath.length <= acceptStepLimit) {
                  return { bestStartId: sid, paths: [finalPath], minSteps: finalPath.length, timedOut: false }
                }
                if (ALLOW_NEAR_MISS && finalPath.length === acceptStepLimit + 1) {
                  try { onProgress?.({ phase:'near_miss', source:'seed', startId: sid, len: finalPath.length, stepLimit: acceptStepLimit }) } catch {}
                } else if (finalPath.length > (ALLOW_NEAR_MISS ? (acceptStepLimit + 1) : acceptStepLimit)) {
                  try { onProgress?.({ phase:'seed_reject', reason:'step_limit', startId: sid, len: finalPath.length, stepLimit: acceptStepLimit }) } catch {}
                }
              } else {
                return { bestStartId: sid, paths: [finalPath], minSteps: finalPath.length, timedOut: false }
              }
            }
          }
          }
        }
      }
    }
  } catch {}

  // Phase A2: 多锚点桥接优先（multiAnchor）——每一步允许换 startId，并在每一步后重新评估桥接/扩张价值
  // 目的：针对“颜色分量很散/需要桥接”的局面，比“固定起点逐层扩张”更有效。
  if (FLAGS?.multiAnchor) {
    try {
      // 让不同 worker 的探索更“分工”，减少重复：对 anchor/palette 的 tie-break 做轻量可复现打散
      const variantSeed = Number.isFinite(FLAGS?.workerVariant) ? (FLAGS.workerVariant|0) : 0
      const rand = (function(){
        let s = (variantSeed ^ 0x9e3779b9) >>> 0
        return () => {
          // xorshift32
          s ^= (s << 13) >>> 0
          s ^= (s >>> 17) >>> 0
          s ^= (s << 5) >>> 0
          return (s >>> 0) / 4294967296
        }
      })()
      const shuffleInPlace = (arr)=>{
        for (let i=arr.length-1;i>0;i--){
          const j = Math.floor(rand() * (i+1))
          const tmp = arr[i]; arr[i]=arr[j]; arr[j]=tmp
        }
        return arr
      }
      const isUniformColors = (colorsArr)=>{
        let first = null
        for(let i=0;i<triangles.length;i++){
          const t = triangles[i]; const c = colorsArr[i]
          if (t.deleted || !c || c==='transparent') continue
          if (first===null) first = c
          else if (c !== first) return false
        }
        return first!==null
      }
      const lowerBoundColors = (colorsArr)=>{
        const s = new Set()
        for(let i=0;i<triangles.length;i++){
          const t=triangles[i]; const c=colorsArr[i]
          if (t.deleted || !c || c==='transparent') continue
          s.add(c)
        }
        return Math.max(0, s.size - 1)
      }
      const hashColors = (colorsArr)=>{
        // 轻量 hash：stride 采样 + DJB2，避免 join 的巨额开销
        let h = 5381
        const n = colorsArr.length
        const stride = Math.max(1, Math.floor(n / 128))
        for(let i=0;i<n;i+=stride){
          const c = colorsArr[i] || ''
          // 只取前两字符减少开销（颜色为 '#rrggbb'）
          const a = c.charCodeAt(0) || 0
          const b = c.charCodeAt(1) || 0
          h = ((h<<5)+h) + a; h|=0
          h = ((h<<5)+h) + b; h|=0
        }
        h = ((h<<5)+h) + (lowerBoundColors(colorsArr)|0); h|=0
        return String(h>>>0)
      }
      const buildRegion = (colorsArr, sid)=>{
        const idxS = idToIndex.get(sid)
        if (idxS==null) return null
        const rc = colorsArr[idxS]
        if (!rc || rc==='transparent' || triangles[idxS].deleted) return null
        const rs = new Set()
        const q=[sid]; const visited=new Set([sid])
        while(q.length){
          const id=q.shift(); const idx=idToIndex.get(id)
          if (idx==null) continue
          if (triangles[idx].deleted) continue
          if (colorsArr[idx]!==rc) continue
          rs.add(id)
          for(const nb of neighbors[idx] || []){
            if(!visited.has(nb)){ visited.add(nb); q.push(nb) }
          }
        }
        return rs.size ? rs : null
      }
      const boundaryScoreDynamic = (colorsArr, sid)=>{
        const idxS = idToIndex.get(sid)
        if (idxS==null) return -Infinity
        const t0 = triangles[idxS]
        if (!t0 || t0.deleted) return -Infinity
        const c0 = colorsArr[idxS]
        if (!c0 || c0==='transparent') return -Infinity
        let s = 0
        for (const nb of (neighbors[idxS] || [])) {
          const nidx = idToIndex.get(nb)
          if (nidx==null) continue
          const tn = triangles[nidx]
          if (!tn || tn.deleted) continue
          const cn = colorsArr[nidx]
          if (!cn || cn==='transparent') continue
          if (cn !== c0) s++
        }
        return s
      }

      // 到边缘距离（用于惩罚“角落/贴边等待被吞没”的色块作为起点）
      let distToBorder = null

      // region 级桥接价值：对“具体连通色块”打分，而不是对颜色整体打分。
      // 目标：优先选择“接触面广/可桥接多处/不在死角”的色块作为锚点；
      //      角落里等待被吞没的色块会因“边缘惩罚 + 接触单一”而降分。
      const regionBridgeValue = (colorsArr, sid)=>{
        const idxS = idToIndex.get(sid)
        if (idxS==null) return -Infinity
        const rc = colorsArr[idxS]
        if (!rc || rc==='transparent' || triangles[idxS].deleted) return -Infinity

        const region = buildRegion(colorsArr, sid)
        if (!region) return -Infinity

        let boundaryEdges = 0
        const adjColors = new Set()
        const boundaryNodes = [] // {id,c}
        let borderish = 0
        let distSum = 0
        let distCnt = 0

        for (const id of region) {
          const idx = idToIndex.get(id)
          const nbs = neighbors[idx] || []
          if (nbs.length < 3) borderish++
          if (distToBorder && Number.isFinite(distToBorder[idx])) { distSum += distToBorder[idx]; distCnt++ }
          for (const nb of nbs) {
            const j = idToIndex.get(nb)
            if (j==null) continue
            const t2 = triangles[j]
            if (!t2 || t2.deleted) continue
            const c2 = colorsArr[j]
            if (!c2 || c2==='transparent') continue
            if (c2 !== rc) {
              boundaryEdges++
              adjColors.add(c2)
              boundaryNodes.push({ id: nb, c: c2 })
            }
          }
        }

        if (boundaryEdges <= 0) return -Infinity

        // 近似“碎片度”：只在 boundaryNodes 子图中按颜色分组做连通片计数（轻量）
        let fragSum = 0
        try {
          const byColor = new Map() // c -> Set(ids)
          for (const bn of boundaryNodes) {
            let set = byColor.get(bn.c)
            if (!set) { set = new Set(); byColor.set(bn.c, set) }
            set.add(bn.id)
          }
          const MAX_BN = 600
          let processed = 0
          for (const [c, set] of byColor.entries()) {
            if (processed >= MAX_BN) break
            const ids = Array.from(set)
            processed += ids.length
            const inSet = set
            const seen = new Set()
            let comps = 0
            for (const id of ids) {
              if (seen.has(id)) continue
              comps++
              const q = [id]; seen.add(id)
              while (q.length) {
                const u = q.shift()
                const uidx = idToIndex.get(u)
                for (const v of neighbors[uidx] || []) {
                  if (!inSet.has(v) || seen.has(v)) continue
                  seen.add(v); q.push(v)
                }
              }
              if (comps >= 12) break
            }
            fragSum += comps
          }
        } catch {}

        const regionSize = region.size
        const adjD = adjColors.size
        const compsHint = (COLOR_COMP_COUNT?.get && COLOR_COMP_COUNT.get(rc)) ? (COLOR_COMP_COUNT.get(rc)||1) : 1
        const avgDist = distCnt > 0 ? (distSum / distCnt) : 0

        // 评分策略（按你的要求）：桥接/联通扩张价值主导。
        // - adjD：接触“多少种不同色块/颜色”（越多越像枢纽）
        // - fragSum：边界附近越碎，越容易通过一两步桥接撬动更多区域
        // - boundaryEdges：边界长度越强，潜在可操作面越大
        // 面积/贴边/中心只做非常弱的 tie-break，不允许盖过桥接收益。
        let score = (adjD * 22) + (fragSum * 6.0) + (boundaryEdges * 0.12)
        score *= (1 + 0.12 * Math.max(0, compsHint - 1))

        // 极弱的“边缘/面积”惩罚：只在桥接收益很低时才略降分
        if (adjD <= 2 && fragSum <= 2) {
          score -= borderish * 0.8
          // 大块可能是背景，但不强惩罚（避免误伤“贴边但高桥接”的关键块）
          score -= Math.pow(regionSize, 0.35) * 0.15
          if (avgDist < 0.9) score -= 2.0
        }
        return score
      }
      // 计算“主色”（全局最重要的颜色，通常是面积最大/最值得先联通的颜色）
      // 注意：此处使用 baseColors（初始局面）做主色判定，足够支撑“先两步连通主色”的启发式。
      let dominantColor = null

      const applyAction = (colorsArr, sid, targetColor)=>{
        const idxS = idToIndex.get(sid)
        if (idxS==null) return null
        const curColor = colorsArr[idxS]
        if (!curColor || curColor==='transparent' || triangles[idxS].deleted) return null
        if (!targetColor || targetColor==='transparent') return null
        if (targetColor === curColor) return { colors: colorsArr, delta: 0, newRegionSize: 0, boundaryCut: 0, touched: 0 }

        const region = buildRegion(colorsArr, sid)
        if (!region) return null

        const next = colorsArr.slice()
        for (const id of region) {
          const ii = idToIndex.get(id); if (ii!=null) next[ii] = targetColor
        }

        // 计算“扩张后区域”（与游戏逻辑一致：涂色后会连上同色块）
        const reg2 = buildRegion(next, sid)
        const newRegionSize = reg2 ? reg2.size : region.size
        const delta = Math.max(0, newRegionSize - region.size)

        // boundaryCut：边界颜色种类减少（桥接/消除隔离更重要）
        const boundaryDistinct = (colorsX, regSet)=>{
          const set = new Set()
          const rc = colorsX[idxS]
          for (const id of regSet){
            const idx = idToIndex.get(id)
            for (const nb of neighbors[idx] || []){
              const nidx = idToIndex.get(nb)
              if (nidx==null) continue
              const tn = triangles[nidx]
              if (!tn || tn.deleted) continue
              const c = colorsX[nidx]
              if (!c || c==='transparent') continue
              if (c !== rc) set.add(c)
            }
          }
          return set.size
        }
        const bdBefore = boundaryDistinct(colorsArr, region)
        const bdAfter = reg2 ? boundaryDistinct(next, reg2) : bdBefore
        const boundaryCut = Math.max(0, bdBefore - bdAfter)

        // 主色接触度：如果本次把区域染成某色后，其边界能同时接触更多主色边缘，下一步更容易“合并主色大块”
        let domContact = 0
        if (dominantColor) {
          try {
            const regX = reg2 || region
            for (const id of regX){
              const idx = idToIndex.get(id)
              for (const nb of neighbors[idx] || []){
                const nidx = idToIndex.get(nb)
                if (nidx==null) continue
                const tn = triangles[nidx]
                if (!tn || tn.deleted) continue
                if (next[nidx] === dominantColor) domContact++
              }
            }
            // 压缩一下，避免数值过大
            domContact = Math.min(80, domContact)
          } catch {}
        }

        // touched：本次选择的颜色在边界接触的“不同连通片段”数量近似（桥接到多片更好）
        let touched = 0
        try {
          const seeds = []
          const regSet = region
          const rc = colorsArr[idxS]
          for (const id of regSet){
            const idx = idToIndex.get(id)
            for (const nb of neighbors[idx] || []){
              const nidx = idToIndex.get(nb)
              if (nidx==null) continue
              const tn = triangles[nidx]
              if (!tn || tn.deleted) continue
              const cn = colorsArr[nidx]
              if (cn === targetColor && cn !== rc) seeds.push(nb)
            }
          }
          const seen = new Set()
          for (const s of seeds){
            if (seen.has(s)) continue
            // BFS 在“原图颜色”为 targetColor 的连通片上计数
            touched++
            const q=[s]; seen.add(s)
            while(q.length){
              const u=q.shift(); const uidx=idToIndex.get(u)
              for (const v of neighbors[uidx] || []){
                const vidx=idToIndex.get(v)
                if (vidx==null) continue
                const tv = triangles[vidx]
                if (!tv || tv.deleted) continue
                if (!seen.has(v) && colorsArr[vidx]===targetColor){
                  seen.add(v); q.push(v)
                }
              }
            }
            if (touched >= 6) break // 上限，防止太慢
          }
        } catch {}

        return { colors: next, delta, newRegionSize, boundaryCut, touched, bdAfter, domContact }
      }

      // 把“超一步可行解”压回 acceptStepLimit：做局部搜索（swap/insert/window reorder）并尝试删一步得到 acceptStepLimit。
      // 注意：仅在 1/4 “近似组”线程启用 ALLOW_NEAR_MISS 时触发；且带时间预算，避免拖慢主搜索。
      const tryReduceActionsByOne = (actions)=>{
        try {
          if (!Number.isFinite(acceptStepLimit)) return null
          if (!Array.isArray(actions)) return null
          if (actions.length !== acceptStepLimit + 1) return null

          const baseColors0 = triangles.map(t=>t.color)
          const budgetMs = Number.isFinite(FLAGS?.nearMissOptimizeBudgetMs) ? Math.max(20, Math.min(400, FLAGS.nearMissOptimizeBudgetMs)) : 120
          const t0 = Date.now()
          const simulate = (acts)=>{
            let cur = baseColors0.slice()
            for (const a of acts){
              const sid = a?.startId
              const color = a?.color
              if (sid==null || !color) return null
              const r = applyAction(cur, sid, color)
              if (!r || !r.colors) return null
              cur = r.colors
            }
            return cur
          }

          const isUniformEnd = (end)=>{
            if (!end) return false
            let first=null
            for(let k=0;k<triangles.length;k++){
              const t=triangles[k]; const c=end[k]
              if(t.deleted || !c || c==='transparent') continue
              if(first===null) first=c
              else if(c!==first) return false
            }
            return first!==null
          }

          const tryDeleteAny = (seq)=>{
            for (let i=0;i<seq.length;i++){
              if (Date.now() - t0 > budgetMs) return null
              const tryPath = seq.slice(0,i).concat(seq.slice(i+1))
              if (isUniformEnd(simulate(tryPath))) return tryPath
            }
            return null
          }

          // 0) 先直接删一步（最快）
          {
            const r = tryDeleteAny(actions)
            if (r) return r
          }

          // 1) 生成少量“邻域序列”（仍为 8 步），对每个序列尝试删一步 -> 7
          const variants = []
          const pushVar = (seq)=>{
            if (!seq) return
            // 去重：用 startId+color 的短串
            const key = seq.map(s=>`${s.startId}|${s.color}`).join(',')
            if (!seenKeys.has(key)) { seenKeys.add(key); variants.push(seq) }
          }
          const seenKeys = new Set()
          pushVar(actions)

          // 1.1) 相邻交换（全尝试）
          for (let i=0;i+1<actions.length;i++){
            const s = actions.slice()
            const tmp = s[i]; s[i]=s[i+1]; s[i+1]=tmp
            pushVar(s)
          }

          // 1.2) 任意交换（抽样，避免爆炸）
          {
            const maxPairs = 18
            let cnt = 0
            for (let a=0;a<actions.length && cnt<maxPairs;a++){
              for (let b=a+2;b<actions.length && cnt<maxPairs;b++){
                // 采样：只挑部分 pair（近似随机）
                if (((a*13 + b*7 + actions.length) % 3) !== 0) continue
                const s = actions.slice()
                const tmp = s[a]; s[a]=s[b]; s[b]=tmp
                pushVar(s); cnt++
              }
            }
          }

          // 1.3) 插入移动（把一步挪到别处，抽样）
          {
            const maxMoves = 18
            let cnt = 0
            for (let from=0; from<actions.length && cnt<maxMoves; from++){
              for (let to=0; to<actions.length && cnt<maxMoves; to++){
                if (from===to) continue
                if (((from*11 + to*5) % 4) !== 0) continue
                const s = actions.slice()
                const [x] = s.splice(from,1)
                s.splice(to,0,x)
                pushVar(s); cnt++
              }
            }
          }

          // 1.4) 小窗口重排（长度4）：reverse / rotate / swap-inside（覆盖“关键次序没走好”）
          for (let i=0;i+3<actions.length;i++){
            const w = actions.slice(i,i+4)
            // reverse
            pushVar(actions.slice(0,i).concat([...w].reverse(), actions.slice(i+4)))
            // rotate left
            pushVar(actions.slice(0,i).concat([w[1],w[2],w[3],w[0]], actions.slice(i+4)))
            // rotate right
            pushVar(actions.slice(0,i).concat([w[3],w[0],w[1],w[2]], actions.slice(i+4)))
            // swap 0<->2
            pushVar(actions.slice(0,i).concat([w[2],w[1],w[0],w[3]], actions.slice(i+4)))
          }

          // 2) 对每个 8 步变体尝试删一步得到 7 步
          for (const v of variants){
            if (Date.now() - t0 > budgetMs) break
            const r = tryDeleteAny(v)
            if (r) return r
          }
        } catch {}
        return null
      }

      // 候选锚点集合：来自 top components 的候选起点 + 随机采样少量边界点
      const baseColors = triangles.map(t=>t.color)
      // 主色：不是“面积最大”，而是“边界接触多 + 相邻色种类多 + 分量多”的颜色
      // 目标：更贴近“像针一样扎进去/边界接触非常多”的主推色（例如你的黑色）。
      // 评分： (邻接色种类 * 8 + 跨边界边数 * 0.04) * (1 + 0.25*(分量数-1)) / area^0.68
      // - 邻接色种类：更能反映“接触面广/扩张潜力大”
      // - 分量数：更偏向需要桥接联通的颜色
      // - area^0.68：对超大背景色做抑制，避免误选背景
      const domMeta = { top: [] }
      dominantColor = (function(){
        const area = new Map()
        const bEdges = new Map()
        const bNei = new Map() // color -> Set(adjacent colors)
        for(let i=0;i<triangles.length;i++){
          const t=triangles[i]; const c=baseColors[i]
          if (t.deleted || !c || c==='transparent') continue
          area.set(c, (area.get(c)||0) + 1)
        }
        for(let i=0;i<triangles.length;i++){
          const t=triangles[i]; const c=baseColors[i]
          if (t.deleted || !c || c==='transparent') continue
          const nbs = neighbors[i] || []
          for (const nb of nbs) {
            const j = idToIndex.get(nb)
            if (j==null) continue
            const t2 = triangles[j]
            if (!t2 || t2.deleted) continue
            const c2 = baseColors[j]
            if (!c2 || c2==='transparent') continue
            if (c2 === c) continue
            bEdges.set(c, (bEdges.get(c)||0) + 1)
            let set = bNei.get(c)
            if (!set) { set = new Set(); bNei.set(c, set) }
            set.add(c2)
          }
        }
        let bestC = null, bestS = -Infinity
        for (const [c, a0] of area.entries()){
          const a = a0 || 1
          const e = bEdges.get(c) || 0
          const d = (bNei.get(c)?.size) || 0
          const comps = (typeof COLOR_COMP_COUNT !== 'undefined' && COLOR_COMP_COUNT?.get) ? (COLOR_COMP_COUNT.get(c)||1) : 1
          const s = ((d * 8) + (e * 0.04)) * (1 + 0.25 * Math.max(0, comps - 1)) / Math.pow(a, 0.68)
          domMeta.top.push({ c, s, d, e, a, comps })
          if (s > bestS) { bestS = s; bestC = c }
        }
        domMeta.top.sort((x,y)=> y.s - x.s)
        domMeta.top = domMeta.top.slice(0, 5)
        return bestC
      })()
      try {
        onProgress?.({ phase:'multi_anchor_setup', dominantColor, domTop: domMeta.top })
      } catch {}
      const preferred = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS.preferredStartId : null
      const focusAnchorIds = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Array.isArray(self.SOLVER_FLAGS.focusAnchorIds)) ? self.SOLVER_FLAGS.focusAnchorIds.filter(x=>x!=null) : null
      const focusPrimaryAnchorId = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? (self.SOLVER_FLAGS.focusPrimaryAnchorId ?? null) : null
      const internalBridgeIds = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Array.isArray(self.SOLVER_FLAGS.internalBridgeIds)) ? self.SOLVER_FLAGS.internalBridgeIds.filter(x=>x!=null) : null
      const internalBridgeOnly = (typeof self !== 'undefined' && self.SOLVER_FLAGS && self.SOLVER_FLAGS.internalBridgeOnly === true)
      const internalSearchMode = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? (self.SOLVER_FLAGS.internalSearchMode || null) : null
      const internalDfsSplitDepth = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.internalDfsSplitDepth)) ? Math.max(0, Math.floor(self.SOLVER_FLAGS.internalDfsSplitDepth)) : 2
      const internalDfsLane = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.internalDfsLane)) ? Math.max(0, Math.floor(self.SOLVER_FLAGS.internalDfsLane)) : 0
      const internalDfsLaneCount = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.internalDfsLaneCount)) ? Math.max(1, Math.floor(self.SOLVER_FLAGS.internalDfsLaneCount)) : 1
      const internalDfsLockAnchorDepth = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.internalDfsLockAnchorDepth)) ? Math.max(0, Math.floor(self.SOLVER_FLAGS.internalDfsLockAnchorDepth)) : 3
      const anchorPool = new Set()
      // 强制聚焦：若前端下发 focusAnchorIds，则 anchorPool 以这些“高桥接色块代表点”为核心，避免落到低分角落。
      if (internalBridgeOnly && Array.isArray(internalBridgeIds) && internalBridgeIds.length) {
        for (const sid of internalBridgeIds) anchorPool.add(sid)
        if (focusPrimaryAnchorId!=null) anchorPool.add(focusPrimaryAnchorId)
        if (preferred!=null) anchorPool.add(preferred)
      } else if (Array.isArray(focusAnchorIds) && focusAnchorIds.length) {
        for (const sid of focusAnchorIds) anchorPool.add(sid)
        if (focusPrimaryAnchorId!=null) anchorPool.add(focusPrimaryAnchorId)
        if (preferred!=null) anchorPool.add(preferred)
      } else {
        if (preferred!=null) anchorPool.add(preferred)
        for (const comp of components.slice(0, Math.min(8, components.length))){
          for (const sid of (comp.startCandidates || [])) anchorPool.add(sid)
        }
        // 补充：从全图采样边界高的点（避免只在同一片区域打转）
        {
          const activeIds = []
          for (let i=0;i<triangles.length;i++){
            const t=triangles[i]
            if (!t || t.deleted || !t.color || t.color==='transparent') continue
            activeIds.push(t.id)
          }
          const sampleN = Math.min(900, activeIds.length)
          for (let i=0;i<sampleN;i++){
            const rid = activeIds[Math.floor(Math.random()*activeIds.length)]
            if (rid!=null) anchorPool.add(rid)
          }
        }
      }
      // anchor/palette 做一次轻量打散，避免多线程重复排序结果完全一致
      const anchorListRaw = shuffleInPlace(Array.from(anchorPool).filter(x=>x!=null))

      // 预计算到边缘距离：边缘点定义为 neighbors.length<3（在三角网格中是外边界）
      // 用于 regionBridgeValue 的中心性惩罚/奖励，避免从角落色块开局。
      try {
        const n = triangles.length
        distToBorder = new Array(n).fill(Infinity)
        const q = []
        for (let i=0;i<n;i++){
          const t = triangles[i]
          const c = baseColors[i]
          if (!t || t.deleted || !c || c==='transparent') continue
          const deg = (neighbors[i] || []).length
          if (deg < 3) { distToBorder[i] = 0; q.push(i) }
        }
        let qi = 0
        while (qi < q.length) {
          const u = q[qi++]
          const du = distToBorder[u]
          for (const nb of neighbors[u] || []) {
            const v = idToIndex.get(nb)
            if (v==null) continue
            const t = triangles[v]
            const c = baseColors[v]
            if (!t || t.deleted || !c || c==='transparent') continue
            if (distToBorder[v] > du + 1) {
              distToBorder[v] = du + 1
              q.push(v)
            }
          }
        }
      } catch { distToBorder = null }
      // 多锚点 beam：每个状态动态挑 top anchor
      const BEAM_W = Number.isFinite(FLAGS?.multiAnchorBeamWidth) ? Math.max(2, FLAGS.multiAnchorBeamWidth) : 24
      const ANCHOR_K = Number.isFinite(FLAGS?.multiAnchorAnchors) ? Math.max(2, FLAGS.multiAnchorAnchors) : 10
      const COLOR_K = Number.isFinite(FLAGS?.multiAnchorColorsPerAnchor) ? Math.max(2, FLAGS.multiAnchorColorsPerAnchor) : 5
      const paletteLocal = Array.isArray(palette) ? shuffleInPlace([...palette]) : palette
      // 默认更“桥接主导”：连通/边界收缩权重大于扩张，避免退化成一层层扩张。
      const wConnect = Number.isFinite(FLAGS?.multiAnchorConnectW) ? FLAGS.multiAnchorConnectW : 12.0
      const wCut = Number.isFinite(FLAGS?.multiAnchorCutW) ? FLAGS.multiAnchorCutW : 6.0
      const wDelta = Number.isFinite(FLAGS?.multiAnchorDeltaW) ? FLAGS.multiAnchorDeltaW : 0.7
      const wDisp = Number.isFinite(FLAGS?.multiAnchorDispW) ? FLAGS.multiAnchorDispW : 0.2
      const wDom = Number.isFinite(FLAGS?.multiAnchorDomW) ? FLAGS.multiAnchorDomW : 5.0
      const wBdVar = Number.isFinite(FLAGS?.multiAnchorBdVarW) ? FLAGS.multiAnchorBdVarW : 1.2
      const wUnlock = Number.isFinite(FLAGS?.multiAnchorUnlockW) ? FLAGS.multiAnchorUnlockW : 1.2
      // region 锚点价值权重：让“高桥接价值色块”天然更容易被反复选作起点
      const wAnchor = Number.isFinite(FLAGS?.multiAnchorAnchorW) ? FLAGS.multiAnchorAnchorW : 1.0
      // -------------------- A组内部DFS：同起点、前几步一致；到分叉点按 lane 分区深度优先到底 --------------------
      // 触发：internalBridgeOnly + internalSearchMode==='dfs' + internalBridgeIds(单一起点)
      // 说明：
      // - splitDepth 前：所有 lane 走同一条“最优”前缀
      // - splitDepth 后：每个 lane 只探索 (childIndex % laneCount)==lane 的分支，天然避免重复
      // - 失败就回溯继续，直到时间/步数耗尽
      if (internalBridgeOnly && internalSearchMode === 'dfs' && Array.isArray(internalBridgeIds) && internalBridgeIds.length) {
        const primarySid = internalBridgeIds[0]
        const deadlineDfs = startTime + TIME_BUDGET_MS
        const splitD = internalDfsSplitDepth
        const lane = internalDfsLane
        const laneCount = internalDfsLaneCount
        const lockDepth = internalDfsLockAnchorDepth
        const stack = [{ colors: baseColors, path: [], hash: hashColors(baseColors) }]
        const seenBest = new Map([[hashColors(baseColors), 0]])
        let dfsNodesLocal = 0
        while (stack.length && Date.now() < deadlineDfs) {
          const st = stack.pop()
          const depthNow = st.path.length
          if (Number.isFinite(stepLimitLocal) && depthNow >= stepLimitLocal) continue
          // 统一性检查（快速）
          if (isUniformSimple(st.colors.map((c,i)=>({ color:c,id:i,neighbors:neighbors[i],deleted:triangles[i]?.deleted })))) {
            try { onProgress?.({ phase:'solution', minSteps: depthNow, solutions: 1, elapsedMs: Date.now() - startTime, internalDfs: true }) } catch {}
            return { paths: [st.path], minSteps: depthNow, timedOut: false }
          }
          dfsNodesLocal++
          if (onProgress && PROGRESS_DFS_INTERVAL_MS>0 && (dfsNodesLocal % 240 === 0)) {
            try { onProgress({ phase:'dfs', nodes: dfsNodesLocal, depth: depthNow, elapsedMs: Date.now() - startTime, maxDepth: stepLimitLocal, internalDfs: true, lane, laneCount }) } catch {}
          }
          // 选锚点：前 lockDepth 步固定 primarySid；后续允许动态挑 top anchor（但仍只围绕 anchorPool）
          let anchors = [{ sid: primarySid, s: 1e9 }]
          if (depthNow >= lockDepth) {
            try {
              const preK = Math.min(140, Math.max(ANCHOR_K * 10, 60))
              const fast = anchorListRaw.map(sid=>({ sid, s: boundaryScoreDynamic(st.colors, sid) }))
                .filter(x=>Number.isFinite(x.s) && x.s>0)
                .sort((a,b)=>b.s-a.s)
                .slice(0, preK)
              anchors = fast
                .map(x=>({ sid: x.sid, s: regionBridgeValue(st.colors, x.sid) }))
                .filter(x=>Number.isFinite(x.s))
                .sort((a,b)=>b.s-a.s)
                .slice(0, ANCHOR_K)
              if (!anchors.length) anchors = [{ sid: primarySid, s: 1 }]
            } catch { anchors = [{ sid: primarySid, s: 1 }] }
          }
          // 生成下一步候选（按评分排序）
          const children = []
          for (const a of anchors) {
            const sid = a.sid
            const region = buildRegion(st.colors, sid)
            if (!region) continue
            const idxS = idToIndex.get(sid)
            const rc = st.colors[idxS]
            const adj = new Set()
            for (const id of region){
              const idx = idToIndex.get(id)
              for (const nb of neighbors[idx] || []){
                const nidx = idToIndex.get(nb)
                if (nidx==null) continue
                const tn = triangles[nidx]
                if (!tn || tn.deleted) continue
                const c = st.colors[nidx]
                if (!c || c==='transparent') continue
                if (c !== rc) adj.add(c)
              }
            }
            const candColors = (adj.size ? Array.from(adj) : paletteLocal).filter(c=>c && c!=='transparent' && c!==rc)
            candColors.sort((c1,c2)=> (COLOR_COMP_COUNT.get(c2)||1) - (COLOR_COMP_COUNT.get(c1)||1))
            const pickColors = candColors.slice(0, Math.max(COLOR_K, 10))
            for (const color of pickColors){
              const r = applyAction(st.colors, sid, color)
              if (!r) continue
              const g = depthNow + 1
              if (Number.isFinite(stepLimitLocal) && g > stepLimitLocal) continue
              const h = hashColors(r.colors)
              const prev = seenBest.get(h)
              if (prev != null && prev <= g) continue
              seenBest.set(h, g)
              // 评分：尽量复用已有的桥接主导指标（不引入“一跳分”概念）
              const compCount = (COLOR_COMP_COUNT.get(color)||1)
              const bridgeScore = (r.touched||0) * wConnect + (r.boundaryCut||0) * wCut + (r.delta||0) * wDelta + compCount * wDisp + (r.domContact||0) * wDom + (a.s||0) * wAnchor
              const bdVarPenalty = (Number.isFinite(r.bdAfter) ? r.bdAfter : 0) * wBdVar
              const scoreChild = bridgeScore - bdVarPenalty
              const path = [...st.path, { startId: sid, color }]
              children.push({ colors: r.colors, path, hash: h, score: scoreChild })
            }
          }
          if (!children.length) continue
          children.sort((x,y)=> (y.score||0)-(x.score||0))
          // splitDepth：按 lane 分区，避免不同线程重复走同一分支
          let picked = children
          if (depthNow >= splitD) {
            picked = []
            for (let bi=0; bi<children.length; bi++){
              if ((bi % laneCount) === (lane % laneCount)) picked.push(children[bi])
            }
            if (!picked.length) picked = [children[lane % children.length]]
          }
          // DFS：反向 push，保证更高分先出栈
          for (let k=picked.length-1; k>=0; k--) stack.push(picked[k])
        }
        // DFS 未找到：让后续正常策略继续（不算错误）
      }
      // hubs 直连奖励：前几步优先用最少步把高评分色块“打通在一起”
      const wHub = Number.isFinite(FLAGS?.multiAnchorHubW) ? FLAGS.multiAnchorHubW : 24.0
      const hubDepth = Number.isFinite(FLAGS?.multiAnchorHubDepth) ? Math.max(0, Math.min(3, FLAGS.multiAnchorHubDepth)) : 2
      const wHub2 = Number.isFinite(FLAGS?.multiAnchorHub2W) ? FLAGS.multiAnchorHub2W : 14.0
      // 成本惩罚系数：越小越偏“优先桥接”，越大越偏“尽快收束下界”
      const wCost = Number.isFinite(FLAGS?.multiAnchorCostW) ? FLAGS.multiAnchorCostW : 2.2
      const unlockDepth = Number.isFinite(FLAGS?.multiAnchorUnlockDepth) ? Math.max(0, Math.min(2, FLAGS.multiAnchorUnlockDepth)) : 1
      const unlockAnchors = Number.isFinite(FLAGS?.multiAnchorUnlockAnchors) ? Math.max(1, Math.min(16, FLAGS.multiAnchorUnlockAnchors)) : 4
      const unlockColors = Number.isFinite(FLAGS?.multiAnchorUnlockColors) ? Math.max(1, Math.min(12, FLAGS.multiAnchorUnlockColors)) : 3

      // 轻量一步前瞻：估计“这一步之后下一步可获得的最大桥接分”，用于“解除包裹/解锁口袋”
      const evalOneStepPotential = (colorsArr, depthNow)=>{
        if (unlockDepth <= 0 || wUnlock <= 0) return 0
        if (depthNow >= unlockDepth) return 0
        if (Date.now() >= deadline) return 0
        // 挑 top-N anchors
        const preK = Math.min(90, Math.max(unlockAnchors * 10, 40))
        const fast = anchorListRaw
          .map(sid=>({ sid, s: boundaryScoreDynamic(colorsArr, sid) }))
          .filter(x=>Number.isFinite(x.s) && x.s>0)
          .sort((a,b)=>b.s-a.s)
          .slice(0, preK)
        const anchors = fast
          .map(x=>({ sid: x.sid, s: regionBridgeValue(colorsArr, x.sid) }))
          .filter(x=>Number.isFinite(x.s))
          .sort((a,b)=>b.s-a.s)
          .slice(0, unlockAnchors)
        let best = 0
        for (const a of anchors) {
          if (Date.now() >= deadline) break
          const sid = a.sid
          const anchorScore = a.s || 0
          const region = buildRegion(colorsArr, sid)
          if (!region) continue
          const idxS = idToIndex.get(sid)
          const rc = colorsArr[idxS]
          const adj = new Set()
          for (const id of region){
            const idx = idToIndex.get(id)
            for (const nb of neighbors[idx] || []){
              const nidx = idToIndex.get(nb)
              if (nidx==null) continue
              const tn = triangles[nidx]
              if (!tn || tn.deleted) continue
              const c = colorsArr[nidx]
              if (!c || c==='transparent') continue
              if (c !== rc) adj.add(c)
            }
          }
          const candColors = (adj.size ? Array.from(adj) : palette).filter(c=>c && c!=='transparent' && c!==rc)
          candColors.sort((c1,c2)=> (COLOR_COMP_COUNT.get(c2)||1) - (COLOR_COMP_COUNT.get(c1)||1))
          const cap = (anchorScore > 22) ? Math.max(unlockColors, 8) : unlockColors
          const pick = candColors.length > cap ? candColors.slice(0, cap) : candColors
          for (const color of pick) {
            const r = applyAction(colorsArr, sid, color)
            if (!r) continue
            const compCount = (COLOR_COMP_COUNT.get(color)||1)
            const base = (r.touched||0) * wConnect + (r.boundaryCut||0) * wCut + (r.delta||0) * wDelta + compCount * wDisp + (r.domContact||0) * wDom + anchorScore * wAnchor
            const pen = (Number.isFinite(r.bdAfter) ? r.bdAfter : 0) * wBdVar
            const v = Math.max(0, base - pen)
            if (v > best) best = v
          }
        }
        return best
      }

      // 取一小撮“真实目标 hubs”：优先使用前端下发的 hubAnchorIds（只包含 top hubs）。
      // 注意：focusAnchorIds 是“锚点池”（hubs+过渡+内部），不能再被当作 hub 目标集合，否则会误判“两步桥接”。
      const hubAnchorIds = (typeof self !== 'undefined' && self.SOLVER_FLAGS && Array.isArray(self.SOLVER_FLAGS.hubAnchorIds))
        ? self.SOLVER_FLAGS.hubAnchorIds.filter(x=>x!=null)
        : null
      const hubIds = (Array.isArray(hubAnchorIds) && hubAnchorIds.length)
        ? Array.from(new Set(hubAnchorIds)).slice(0, 10)
        : ((Array.isArray(focusAnchorIds) && focusAnchorIds.length)
          ? Array.from(new Set([...(focusPrimaryAnchorId!=null?[focusPrimaryAnchorId]:[]), ...focusAnchorIds])).slice(0, 8)
          : (focusPrimaryAnchorId!=null ? [focusPrimaryAnchorId] : []))
      const hubIdSet = new Set(hubIds)
      const connectedHubCount = (colorsArr, sid)=>{
        try {
          if (!hubIds.length) return 0
          const idxS = idToIndex.get(sid)
          if (idxS==null) return 0
          const c0 = colorsArr[idxS]
          if (!c0 || c0==='transparent' || triangles[idxS].deleted) return 0
          let cnt = 0
          const q=[sid]
          const vis=new Set([sid])
          const LIMIT = 9000
          while(q.length && vis.size < LIMIT){
            const id=q.shift()
            if (hubIdSet.has(id)) {
              cnt++
              if (cnt >= hubIds.length) break
            }
            const idx=idToIndex.get(id)
            if (idx==null) continue
            for(const nb of neighbors[idx] || []){
              if (vis.has(nb)) continue
              const nidx=idToIndex.get(nb)
              if (nidx==null) continue
              const t=triangles[nidx]
              if (!t || t.deleted) continue
              if (colorsArr[nidx]!==c0) continue
              vis.add(nb); q.push(nb)
            }
          }
          return cnt
        } catch { return 0 }
      }

      const estimateBestHubConnectNext = (colorsArr, sid)=>{
        try {
          if (!hubIds.length || wHub2 <= 0) return 0
          // 从 sid 当前连通块边界收集候选颜色（限制规模）
          const region = buildRegion(colorsArr, sid)
          if (!region) return 0
          const adjColors = new Set()
          for (const id of region) {
            const idx = idToIndex.get(id)
            for (const nb of neighbors[idx] || []) {
              const j = idToIndex.get(nb)
              if (j==null) continue
              const t = triangles[j]
              if (!t || t.deleted) continue
              const c2 = colorsArr[j]
              if (!c2 || c2==='transparent') continue
              if (c2 !== colorsArr[idToIndex.get(id)]) adjColors.add(c2)
              if (adjColors.size >= 10) break
            }
            if (adjColors.size >= 10) break
          }
          const cand = Array.from(adjColors)
          if (!cand.length) return 0
          let best = 0
          for (let i=0;i<cand.length;i++){
            const c = cand[i]
            const r2 = applyAction(colorsArr, sid, c)
            if (!r2) continue
            const cnt = connectedHubCount(r2.colors, sid)
            if (cnt > best) best = cnt
            if (best >= hubIds.length) break
          }
          return best
        } catch { return 0 }
      }

      // 从指定锚点的当前连通块边界提取相邻颜色（用于 internal 2-step 破局枚举，避免 palette 采样漏掉关键中间色）
      const getBoundaryAdjColors = (colorsArr, sid, cap=10)=>{
        try {
          const region = buildRegion(colorsArr, sid)
          if (!region) return []
          const idxS = idToIndex.get(sid)
          const rc = colorsArr[idxS]
          const set = new Set()
          for (const id of region) {
            const idx = idToIndex.get(id)
            for (const nb of neighbors[idx] || []) {
              const j = idToIndex.get(nb)
              if (j==null) continue
              const t = triangles[j]
              if (!t || t.deleted) continue
              const c2 = colorsArr[j]
              if (!c2 || c2==='transparent' || c2===rc) continue
              set.add(c2)
              if (set.size >= cap) break
            }
            if (set.size >= cap) break
          }
          return Array.from(set)
        } catch { return [] }
      }

      // beam state
      let beam = [{ colors: baseColors, path: [], score: 0, hash: hashColors(baseColors) }]
      const seenBestDepth = new Map([[beam[0].hash, 0]])

      // 破局分工：部分线程直接从“内部桥梁”发起 2 步桥接（而不是从 A 慢慢扩张到 B）。
      // 触发条件：有 focusAnchorIds（含内部桥梁候选）且存在多个 hub；仅让部分 workerVariant 执行，避免所有线程做同一件事。
      try {
        const doInternal = internalBridgeOnly && (hubIds && hubIds.length >= 2) && Array.isArray(internalBridgeIds) && internalBridgeIds.length
        if (doInternal && (!Number.isFinite(stepLimitLocal) || stepLimitLocal >= 2)) {
          const maxAnchors = Math.min(24, internalBridgeIds.length)
          const basePalette = (Array.isArray(paletteLocal) ? paletteLocal : palette).filter(c=>c && c!=='transparent')
          const seeds = []
          for (let ai=0; ai<maxAnchors; ai++){
            const sid = internalBridgeIds[ai]
            const idxS = idToIndex.get(sid)
            if (idxS==null) continue
            const curC = baseColors[idxS]
            if (!curC || curC==='transparent' || triangles[idxS].deleted) continue
            const c1Pick = (()=>{
              const adj = getBoundaryAdjColors(baseColors, sid, 10)
              // 兜底：若边界色不足，再补 palette 前几项
              const merged = [...adj, ...basePalette]
              const out = []
              for (const c of merged){ if (c && c!=='transparent' && c!==curC && !out.includes(c)) out.push(c); if (out.length>=12) break }
              return out
            })()
            for (const c1 of c1Pick){
              if (c1===curC) continue
              const r1 = applyAction(baseColors, sid, c1)
              if (!r1) continue
              const c2Pick = (()=>{
                const adj2 = getBoundaryAdjColors(r1.colors, sid, 10)
                const merged2 = [...adj2, ...basePalette]
                const out2 = []
                for (const c of merged2){ if (c && c!=='transparent' && c!==c1 && !out2.includes(c)) out2.push(c); if (out2.length>=12) break }
                return out2
              })()
              for (const c2 of c2Pick){
                if (!c2 || c2===c1) continue
                const r2 = applyAction(r1.colors, sid, c2)
                if (!r2) continue
                const hub2 = connectedHubCount(r2.colors, sid)
                if (hub2 < 2) continue
                const score2 = hub2 * 120 + (r1.boundaryCut||0) * 10 + (r2.boundaryCut||0) * 10 + (r1.touched||0) * 6 + (r2.touched||0) * 6
                seeds.push({ sid, c1, c2, score2, colors: r2.colors })
              }
            }
          }
          seeds.sort((a,b)=>b.score2-a.score2)
          const topSeeds = seeds.slice(0, 6)
          for (const s of topSeeds){
            const path = [{ startId: s.sid, color: s.c1 }, { startId: s.sid, color: s.c2 }]
            const h = hashColors(s.colors)
            if (!seenBestDepth.has(h) || seenBestDepth.get(h) > 2) {
              seenBestDepth.set(h, 2)
              beam.push({ colors: s.colors, path, score: s.score2, hash: h })
            }
          }
        }
      } catch {}

      // 保持 beam 有序：让“2 步桥接种子”优先扩展
      try { beam.sort((a,b)=>(b.score||0)-(a.score||0)); beam = beam.slice(0, Math.max(BEAM_W, 12)) } catch {}
      let expanded = 0
      let lastReport = Date.now()
      const deadline = startTime + TIME_BUDGET_MS

      const maxDepth = Number.isFinite(stepLimitLocal) ? stepLimitLocal : Math.min(30, lowerBoundColors(baseColors) + 10)
      while(Date.now() < deadline && beam.length){
        const depth = beam[0].path.length
        if (Number.isFinite(stepLimitLocal) && depth >= stepLimitLocal) break
        if (depth >= maxDepth) break

        const nextStates = []
        for (const st of beam){
          if (Date.now() >= deadline) break
          const depthNow = st.path.length
          // 选 top anchor（动态）：先快筛（单点边界分），再 region 级桥接价值精算。
          const preK = Math.min(140, Math.max(ANCHOR_K * 10, 60))
          const fast = anchorListRaw.map(sid=>({ sid, s: boundaryScoreDynamic(st.colors, sid) }))
            .filter(x=>Number.isFinite(x.s) && x.s>0)
            .sort((a,b)=>b.s-a.s)
            .slice(0, preK)
          let anchorsScored = fast
            .map(x=>({ sid: x.sid, s: regionBridgeValue(st.colors, x.sid) }))
            .filter(x=>Number.isFinite(x.s))
            .sort((a,b)=>b.s-a.s)
            .slice(0, ANCHOR_K)

          // 强制“内部动手”（A组两跳线程）：前两步只允许从 internalBridgeIds（按两跳分降序）里选锚点。
          // 组内分工：优先以 focusPrimaryAnchorId 为第一候选，并顺延取后继两个，减少线程间重复。
          // 注意：不再按 regionBridgeValue 重排（会引入“一跳/当前颜色状态”干扰）。
          if (internalBridgeOnly && depthNow < 2 && Array.isArray(internalBridgeIds) && internalBridgeIds.length) {
            const ids = internalBridgeIds
            const head = (focusPrimaryAnchorId != null) ? focusPrimaryAnchorId : ids[0]
            const idx0 = Math.max(0, ids.findIndex(x=>x===head))
            const pick = [
              ids[idx0],
              ids[(idx0 + 1) % ids.length],
              ids[(idx0 + 2) % ids.length],
            ].filter(x=>x!=null)
            const cand = pick.map((sid, idx)=>({ sid, s: (3 - idx) * 100 }))
            if (cand.length) anchorsScored = cand
          }

          // 策略硬纠偏：前几步强制聚焦“桥接价值最高的色块”及其边界邻居色块，优先用少步打通。
          const focusDepth = Number.isFinite(FLAGS?.multiAnchorFocusDepth) ? Math.max(0, Math.min(6, FLAGS.multiAnchorFocusDepth)) : 3
          const focusK = Number.isFinite(FLAGS?.multiAnchorFocusK) ? Math.max(1, Math.min(8, FLAGS.multiAnchorFocusK)) : 3
          if (focusDepth > 0 && depthNow < focusDepth && anchorsScored.length) {
            const hubs = anchorsScored.slice(0, Math.min(focusK, anchorsScored.length))
            // 扩展：加入 hub 边界上的邻居色块作为候选锚点（桥接往往需要先动“桥梁色块”，而不是 hub 本身）
            const candMap = new Map() // sid -> score
            const add = (sid, score)=>{
              if (sid==null) return
              const prev = candMap.get(sid)
              if (prev==null || score > prev) candMap.set(sid, score)
            }
            const boundaryNeighborSeeds = (colorsArr, hubSid, hubScore)=>{
              const reg = buildRegion(colorsArr, hubSid)
              if (!reg) return
              const picked = new Set()
              let added = 0
              for (const id of reg) {
                const idx = idToIndex.get(id)
                for (const nb of neighbors[idx] || []){
                  const nidx = idToIndex.get(nb)
                  if (nidx==null) continue
                  const tn = triangles[nidx]
                  if (!tn || tn.deleted) continue
                  const c2 = colorsArr[nidx]
                  if (!c2 || c2==='transparent') continue
                  if (c2 === colorsArr[idToIndex.get(hubSid)]) continue
                  if (!picked.has(nb)) {
                    picked.add(nb)
                    // 边界邻居本身可能 region 分数不高，但它“靠近高价值 hub”，给它带一个 hubScore 的加成
                    add(nb, hubScore * 0.9)
                    added++
                    if (added >= 14) return
                  }
                }
              }
            }
            // 若前端指定 primary hub，则优先把它放到 hub 列表首位（所有线程同一焦点，但每线程 primary 不同）
            const hubsOrdered = (()=>{
              if (focusPrimaryAnchorId==null) return hubs
              const idx = hubs.findIndex(x=>x.sid===focusPrimaryAnchorId)
              if (idx<=0) return hubs
              const copy = hubs.slice()
              const it = copy.splice(idx,1)[0]
              copy.unshift(it)
              return copy
            })()
            for (const h of hubsOrdered) {
              add(h.sid, h.s * 1.2)
              boundaryNeighborSeeds(st.colors, h.sid, h.s)
            }
            // 前端下发的 focusAnchorIds（含“内部桥梁/过渡区”）强制加入候选，避免只从 hub 本身慢慢扩张
            try {
              const boost = (hubsOrdered[0]?.s || 1) * 1.15
              if (Array.isArray(focusAnchorIds) && focusAnchorIds.length) {
                for (const sid of focusAnchorIds) add(sid, boost)
              }
              if (focusPrimaryAnchorId != null) add(focusPrimaryAnchorId, boost * 1.08)
            } catch {}
            // 对候选做一次精算（可选），并与 hub 传递分取 max
            const cand = Array.from(candMap.entries()).map(([sid, bonus])=>{
              const s0 = regionBridgeValue(st.colors, sid)
              const s = Math.max(Number.isFinite(s0) ? s0 : -Infinity, bonus)
              return { sid, s }
            }).filter(x=>Number.isFinite(x.s))
              .sort((a,b)=>b.s-a.s)
              .slice(0, Math.max(ANCHOR_K, focusK * 6))
            anchorsScored = cand.length ? cand : anchorsScored

            // 低频打印一次 hub 信息，方便核验是否围绕高价值色块在跑
            if (depthNow === 0 && expanded < 2) {
              try {
                onProgress?.({ phase:'multi_anchor_hubs', depth: depthNow, hubs: hubs.map(x=>({ startId:x.sid, score: Number(x.s.toFixed(2)) })) })
              } catch {}
            }
          }

          for (const a of anchorsScored){
            const sid = a.sid
            const anchorScore = a.s || 0
            const region = buildRegion(st.colors, sid)
            if (!region) continue
            const idxS = idToIndex.get(sid)
            const rc = st.colors[idxS]
            // 只考虑边界上出现的颜色（桥接更有效），fullExpand 时允许全 palette
            const adj = new Set()
            for (const id of region){
              const idx = idToIndex.get(id)
              for (const nb of neighbors[idx] || []){
                const nidx = idToIndex.get(nb)
                if (nidx==null) continue
                const tn = triangles[nidx]
                if (!tn || tn.deleted) continue
                const c = st.colors[nidx]
                if (!c || c==='transparent') continue
                if (c !== rc) adj.add(c)
              }
            }
            const candColors = (adj.size ? Array.from(adj) : paletteLocal).filter(c=>c && c!=='transparent' && c!==rc)
            // 粗排：优先分量多（更散乱）的颜色，提升桥接导向
            candColors.sort((c1,c2)=> (COLOR_COMP_COUNT.get(c2)||1) - (COLOR_COMP_COUNT.get(c1)||1))
            // 桥接主导：对高价值锚点，扩大颜色尝试数，避免错过关键桥接颜色导致“层层扩张”
            const cap = (anchorScore > 22) ? Math.max(COLOR_K, 12) : COLOR_K
            const pickColors = (candColors.length > cap) ? candColors.slice(0, cap) : candColors

            for (const color of pickColors){
              const r = applyAction(st.colors, sid, color)
              if (!r) continue
              const lb = lowerBoundColors(r.colors)
              const g = st.path.length + 1
              const compCount = (COLOR_COMP_COUNT.get(color)||1)
              // 核心：桥接/联通优先 + 主色合并倾向 + 边界复杂度惩罚
              const bridgeScore = (r.touched||0) * wConnect + (r.boundaryCut||0) * wCut + (r.delta||0) * wDelta + compCount * wDisp + (r.domContact||0) * wDom + anchorScore * wAnchor
              const bdVarPenalty = (Number.isFinite(r.bdAfter) ? r.bdAfter : 0) * wBdVar
              // 解锁口袋：看一步后“下一步最大可得桥接分”提升多少
              const curBase = Math.max(0, bridgeScore - bdVarPenalty)
              const nextBest = evalOneStepPotential(r.colors, depthNow)
              const unlockBonus = Math.max(0, nextBest - curBase) * wUnlock
              // 计算一次 hub 连通与两步前瞻，供奖励/惩罚/硬剪枝复用（避免重复 compute）
              const hubCntNow = (hubIds.length && hubDepth > 0 && depthNow < hubDepth) ? connectedHubCount(r.colors, sid) : 0
              const hubBest2 = (hubIds.length && hubDepth > 0 && depthNow < hubDepth) ? estimateBestHubConnectNext(r.colors, sid) : hubCntNow
              // hubs 直连奖励：若一步把多个高价值 hub/过渡区打通在同一连通块，强力加分（优先前2步）
              const hubBonus = (wHub > 0 && hubDepth > 0 && depthNow < hubDepth && hubIds.length)
                ? Math.max(0, (hubCntNow - 1)) * wHub
                : 0
              // 2步桥接：奖励“这一步之后下一步能显著把多个 hub 打通”的动作（内部向外破局）
              const hubUnlock = (wHub2 > 0 && hubDepth > 0 && depthNow < hubDepth && hubIds.length)
                ? Math.max(0, (hubBest2 - hubCntNow)) * wHub2
                : 0
              // 第一层优化（硬剪枝，仅 internalBridgeOnly 线程启用）：
              // - 第一步：若两步内仍无法连到 >=2 hub，直接剪掉
              // - 第二步：若仍未连到 >=2 hub，直接剪掉
              if (internalBridgeOnly && hubIds.length >= 2 && hubDepth > 0 && depthNow < hubDepth) {
                if (depthNow === 0 && hubBest2 < 2) continue
                if (depthNow === 1 && hubCntNow < 2) continue
              }
              // 慢扩张惩罚（所有线程）：若到了第3步仍没把 >=2 个 hub 打通，递增惩罚。
              // 目的：即使“吞没零散区域收益高”，也要让“桥接高评分hub”成为第一优先级。
              let slowBridgePenalty = 0
              if (hubIds.length >= 2) {
                const d2 = depthNow + 1
                if (d2 >= 3 && hubCntNow < 2) slowBridgePenalty = (d2 - 2) * 18
                if (d2 >= 4 && hubCntNow < 3) slowBridgePenalty += (d2 - 3) * 10
              }
              // 强约束倾向：如果前两步内无法达成“至少连接两个高价值 hub”，则强惩罚（迫使从内部桥梁破局，而非 A->B 慢扩张）
              let hubPenalty = 0
              if (hubDepth > 0 && hubIds.length >= 2 && depthNow < hubDepth) {
                const cntNow = hubCntNow
                const best2 = hubBest2
                if (depthNow === 0 && best2 < 2) hubPenalty += 38
                if (depthNow === 1 && cntNow < 2 && best2 < 2) hubPenalty += 28
                if (depthNow === 0 && hubBonus === 0 && hubUnlock === 0) hubPenalty += 18
                // 把两步前瞻再放大一点（更贴近你说的“2 步桥接优先级最高”）
                if (depthNow === 0) { /* no-op, via penalty */ }
              }
              // 非桥接动作强惩罚：压制“纯扩张/一层层扩张”
              const weakBridgePenalty = ((r.touched||0) === 0 && (r.boundaryCut||0) === 0) ? 10 : 0
              // 前几步更愿意“先桥接打通”：降低成本惩罚，让桥接主导
              const focusDepth = Number.isFinite(FLAGS?.multiAnchorFocusDepth) ? Math.max(0, Math.min(6, FLAGS.multiAnchorFocusDepth)) : 3
              const costW = (focusDepth > 0 && depthNow < focusDepth) ? (wCost * 0.72) : wCost
              const score = bridgeScore - bdVarPenalty + unlockBonus + hubBonus + hubUnlock - hubPenalty - slowBridgePenalty - weakBridgePenalty - (g + lb) * costW
              const path2 = st.path.concat([{ startId: sid, color }])
              if (Number.isFinite(stepLimitLocal) && path2.length > stepLimitLocal) continue
              const h = hashColors(r.colors)
              const prevD = seenBestDepth.get(h)
              if (prevD!=null && prevD <= path2.length) continue
              seenBestDepth.set(h, path2.length)

              if (isUniformColors(r.colors)) {
                if (!Number.isFinite(acceptStepLimit) || path2.length <= acceptStepLimit) {
                  return { bestStartId: sid, paths: [path2], minSteps: path2.length, timedOut: false }
                }
                if (ALLOW_NEAR_MISS && Number.isFinite(acceptStepLimit) && path2.length > acceptStepLimit) {
                  // +1：尝试压回 stepLimit；失败则记录 bestNearMiss
                  if (path2.length === acceptStepLimit + 1) {
                    const reduced = tryReduceActionsByOne(path2)
                    if (reduced && reduced.length <= acceptStepLimit) {
                      return { bestStartId: reduced[0]?.startId ?? sid, paths: [reduced], minSteps: reduced.length, timedOut: false }
                    }
                    try {
                      const nmScore = score
                      if (!bestNearMiss || nmScore > (bestNearMiss.score||-Infinity)) bestNearMiss = { startId: sid, path: path2, score: nmScore }
                    } catch {}
                    try { onProgress?.({ phase:'near_miss', source:'multi_anchor', len: path2.length, stepLimit: acceptStepLimit }) } catch {}
                  }
                  // +2：先尝试压回到 +1（满足“至少返回 +1”要求）；再尝试压回 stepLimit
                  if (path2.length === acceptStepLimit + 2) {
                    const reduced1 = tryReduceActionsByOne(path2)
                    if (reduced1 && reduced1.length <= acceptStepLimit) {
                      return { bestStartId: reduced1[0]?.startId ?? sid, paths: [reduced1], minSteps: reduced1.length, timedOut: false }
                    }
                    if (reduced1 && reduced1.length === acceptStepLimit + 1) {
                      // 记录 +1 近似解（优先）
                      try {
                        const nmScore = score
                        if (!bestNearMiss || nmScore > (bestNearMiss.score||-Infinity)) bestNearMiss = { startId: reduced1[0]?.startId ?? sid, path: reduced1, score: nmScore }
                      } catch {}
                      // 再试一次压回 stepLimit（两次删除/重排）
                      const reduced2 = tryReduceActionsByOne(reduced1)
                      if (reduced2 && reduced2.length <= acceptStepLimit) {
                        return { bestStartId: reduced2[0]?.startId ?? sid, paths: [reduced2], minSteps: reduced2.length, timedOut: false }
                      }
                    } else {
                      // 实在压不回 +1：仍记录一个 +2 备选（前端会标注 +2）
                      try {
                        const nmScore = score
                        if (!bestNearMiss2 || nmScore > (bestNearMiss2.score||-Infinity)) bestNearMiss2 = { startId: sid, path: path2, score: nmScore }
                      } catch {}
                    }
                    try { onProgress?.({ phase:'near_miss', source:'multi_anchor', len: path2.length, stepLimit: acceptStepLimit }) } catch {}
                  }
                }
              }

              nextStates.push({ colors: r.colors, path: path2, score, hash: h })
            }
          }
          expanded++
          const now = Date.now()
          if (now - lastReport > 120) {
            lastReport = now
            try { onProgress?.({ phase:'multi_anchor', nodes: expanded, queue: beam.length, elapsedMs: now - startTime, depth: depth, anchors: ANCHOR_K, beam: BEAM_W }) } catch {}
            await new Promise(r=>setTimeout(r,0))
          }
        }

        if (!nextStates.length) break
        nextStates.sort((a,b)=> b.score - a.score)
        beam = nextStates.slice(0, BEAM_W)
      }
    } catch {}
  }

  // Auto-upgrade: when stepLimit exists and normal search makes no progress,
  // run a single strict IDA* probe with a stronger heuristic (dynamic_rag_max by default).
  // Purpose: either find a guaranteed <=stepLimit solution, or quickly reject that startId.
  let didStrictProbe = false

  while (Date.now() - startTime < TIME_BUDGET_MS) {
    if (!didStrictProbe && Number.isFinite(acceptStepLimit) && retry >= 1) {
      const remainingStrict = TIME_BUDGET_MS - (Date.now() - startTime)
      if (remainingStrict > 20000) {
        didStrictProbe = true
        const comp0 = components[0]
        const sid0 = (comp0?.startCandidates && comp0.startCandidates.length) ? comp0.startCandidates[0] : comp0?.startId
        if (sid0 != null) {
          const oldFlags = { ...(self.SOLVER_FLAGS || {}) }
          const heurName = oldFlags.heuristicName || 'dynamic_rag_max'
          try {
            try {
              self.SOLVER_FLAGS = { ...oldFlags, strictMode: true, useIDAStar: true, heuristicName: heurName }
            } catch {}
            try { onProgress?.({ phase:'auto_upgrade', to:'strict_ida_probe', startId: sid0, stepLimit: acceptStepLimit, heuristicName: heurName, elapsedMs: Date.now() - startTime }) } catch {}
            const resStrictProbe = await StrictIDAStarMinSteps(
              triangles,
              sid0,
              palette,
              (p)=>{ try { onProgress?.({ phase:'strict_probe', startId: sid0, ...p }) } catch {} },
              acceptStepLimit
            )
            if (resStrictProbe && Array.isArray(resStrictProbe.paths) && resStrictProbe.paths.length > 0) {
              const ms = resStrictProbe.minSteps
              if (Number.isFinite(ms) && ms <= acceptStepLimit) {
                return { bestStartId: sid0, paths: resStrictProbe.paths, minSteps: ms, timedOut: false }
              }
            }
          } catch {}
          finally {
            try { self.SOLVER_FLAGS = oldFlags } catch {}
          }
          await new Promise(r=>setTimeout(r,0))
        }
      }
    }

    for(const comp of components){
      if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break }
      await new Promise(r=>setTimeout(r,0))
    // 动态束宽调度：长时间无 best_update 则增�?beamWidth、放�?lbImproveMin
    if (ADJUST_ON_NO_PROGRESS) {
      const now = Date.now()
      if (now - lastBestUpdateTs >= SCHED_INTERVAL_MS) {
        try {
          const curBeam = Number.isFinite(self?.SOLVER_FLAGS?.beamWidth) ? self.SOLVER_FLAGS.beamWidth : baseBeamWidth
          const target = (Array.isArray(beamScheduleTargets) && beamScheduleIdx < beamScheduleTargets.length) ? Math.max(curBeam, beamScheduleTargets[beamScheduleIdx]) : (curBeam + 8)
          const newBeam = Math.min(beamMax, Math.max(curBeam, target))
          self.SOLVER_FLAGS.beamWidth = newBeam
          beamScheduleIdx = Math.min(beamScheduleIdx + 1, (beamScheduleTargets?.length || 0))
          const curLbMin = Number.isFinite(self?.SOLVER_FLAGS?.lbImproveMin) ? self.SOLVER_FLAGS.lbImproveMin : baseLbImproveMin
            // 允许降到 0（彻底放开“下界必须改善”的剪枝）
            self.SOLVER_FLAGS.lbImproveMin = Math.max(0, curLbMin - 1)
          // 联动：无进展时小幅提高束宽下限，避免过窄�?
          const curBeamMin = Number.isFinite(self?.SOLVER_FLAGS?.beamMin) ? self.SOLVER_FLAGS.beamMin : baseBeamMin
          self.SOLVER_FLAGS.beamMin = Math.min(baseBeamMin, curBeamMin + 1)
          onProgress?.({ phase:'scheduler_adjust', beamWidth: newBeam, lbImproveMin: self.SOLVER_FLAGS.lbImproveMin, beamMin: self.SOLVER_FLAGS.beamMin, elapsedMs: now - startTime })
          lastBestUpdateTs = now
        } catch {}
      }
    }
    // 起点 LB_local 预筛：若局部下界超出步数预算，跳过该分�?
    if (!self?.SOLVER_FLAGS?.disableStartPrune && Number.isFinite(stepLimitLocal)) {
      try {
        const colorsStart = triangles.map(t=>t.color)
        const startColorLocal = triangles[idToIndex.get(comp.startId)]?.color
        if (startColorLocal) {
          const regionSetLocal = new Set()
          const qLocal = [comp.startId]
          const visitedLocal = new Set([comp.startId])
          while(qLocal.length){
            const cid=qLocal.shift()
            const idx=idToIndex.get(cid)
            const tri=triangles[idx]
            if(tri.deleted || tri.color==='transparent' || tri.color!==startColorLocal) continue
            regionSetLocal.add(cid)
            for(const nb of neighbors[idx]){ if(!visitedLocal.has(nb)){ const nidx=idToIndex.get(nb); const tri2=triangles[nidx]; if(!tri2.deleted && tri2.color!=='transparent' && tri2.color===startColorLocal){ visitedLocal.add(nb); qLocal.push(nb) } } }
          }
          const lbLocalStart = lowerBoundStrictLocalAuto(colorsStart, regionSetLocal, comp.startId)
          if (lbLocalStart > stepLimitLocal) {
            onProgress?.({ phase:'start_pruned', reason:'lb_local_over', startId: comp.startId, lbLocal: lbLocalStart, stepLimit: stepLimitLocal })
            continue
          }
        }
      } catch {}
    }

    // 多起点：同一颜色分量内尝试多个 startId（随降级扩大）
    const startCandK = (retry >= 2) ? 6 : (retry >= 1 ? 3 : 1)
    const startCandidates = (comp?.startCandidates || [comp?.startId]).slice(0, startCandK)
    for (const startIdTry of startCandidates){
      if (startIdTry==null) continue
      if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break }

      // 严格模式：若开启则优先用 strict 求最短路
      if ((self.SOLVER_FLAGS||{}).strictMode) {
        const useIDA = !!(self.SOLVER_FLAGS||{}).useIDAStar
        const resStrict = useIDA
          ? await StrictIDAStarMinSteps(triangles, startIdTry, palette, (p)=>{ onProgress?.({ phase:'subsearch', startId: startIdTry, ...p }) }, stepLimitLocal)
          : await StrictAStarMinSteps(triangles, startIdTry, palette, (p)=>{ onProgress?.({ phase:'subsearch', startId: startIdTry, ...p }) }, stepLimitLocal)
        if(resStrict && resStrict.paths && resStrict.paths.length>0){
          if(resStrict.minSteps < best.minSteps){ best = { startId: startIdTry, minSteps: resStrict.minSteps, paths: resStrict.paths }; onProgress?.({ phase:'best_update', bestStartId: best.startId, minSteps: best.minSteps }); lastBestUpdateTs = Date.now(); if (ADJUST_ON_NO_PROGRESS) { try { self.SOLVER_FLAGS.beamWidth = baseBeamWidth; self.SOLVER_FLAGS.lbImproveMin = baseLbImproveMin; const curBeamMin = Number.isFinite(self?.SOLVER_FLAGS?.beamMin) ? self.SOLVER_FLAGS.beamMin : baseBeamMin; self.SOLVER_FLAGS.beamMin = Math.max(2, Math.min(baseBeamMin, curBeamMin - 1)); beamScheduleIdx = 0; onProgress?.({ phase:'scheduler_reset', beamWidth: self.SOLVER_FLAGS.beamWidth, lbImproveMin: self.SOLVER_FLAGS.lbImproveMin, beamMin: self.SOLVER_FLAGS.beamMin }) } catch {} } }
          if (Number.isFinite(stepLimitLocal) && resStrict.minSteps <= stepLimitLocal) { break }
          if (resStrict.timedOut) timedOut = true
        }
        continue
      }
    // 若启�?DFS-first，先用深度受�?DFS 找到任意可行解并立刻返回
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
          const score=(c)=>{ let s=(gain.get(c)||0)*3 + getColorBiasRAG(c); return s }
          const fullExpand = !!(self.SOLVER_FLAGS||{}).fullExpand
          const arr = raw.sort((a,b)=>score(b)-score(a))
          return (fullExpand ? arr : arr.slice(0,8)).filter(c=>c!==rc)
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
          const RETURN_FIRST = !!(self.SOLVER_FLAGS||{}).returnFirstFeasible
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
      const res = await Solver_minSteps(triangles, startIdTry, palette, maxBranches, (p)=>{
        onProgress?.({ phase:'subsearch', startId: startIdTry, ...p })
      }, stepLimitLocal)
      if(res && res.paths && res.paths.length>0){
        if(res.minSteps < best.minSteps){ best = { startId: startIdTry, minSteps: res.minSteps, paths: res.paths }; onProgress?.({ phase:'best_update', bestStartId: best.startId, minSteps: best.minSteps }); lastBestUpdateTs = Date.now(); if (ADJUST_ON_NO_PROGRESS) { try { self.SOLVER_FLAGS.beamWidth = baseBeamWidth; self.SOLVER_FLAGS.lbImproveMin = baseLbImproveMin; const curBeamMin = Number.isFinite(self?.SOLVER_FLAGS?.beamMin) ? self.SOLVER_FLAGS.beamMin : baseBeamMin; self.SOLVER_FLAGS.beamMin = Math.max(2, Math.min(baseBeamMin, curBeamMin - 1)); beamScheduleIdx = 0; onProgress?.({ phase:'scheduler_reset', beamWidth: self.SOLVER_FLAGS.beamWidth, lbImproveMin: self.SOLVER_FLAGS.lbImproveMin, beamMin: self.SOLVER_FLAGS.beamMin }) } catch {} } }
        if (Number.isFinite(stepLimitLocal) && res.minSteps <= stepLimitLocal) {
          break
        }
        if (res.timedOut) timedOut = true
      }
    } // end startCandidates loop
    }

    if(best.minSteps!==Infinity) break
    if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break }

    // 未找到合格解：降级策略并重试（不设次数上限，直到 3 分钟）
    retry++
    // 若用户设置了过低的步数上限，允许在深度重试时逐步放宽（默认开启，可通过 flags.allowStepLimitRelax=false 关闭）
    if (ALLOW_STEP_LIMIT_RELAX && Number.isFinite(stepLimitLocal)) {
      if (retry >= 2) stepLimitLocal = Math.min(9999, stepLimitLocal + 5)
      if (retry >= 4) stepLimitLocal = Infinity
    }
    const cur = self.SOLVER_FLAGS || {}
    const next = { ...cur }
    next.workerTimeBudgetMs = TIME_BUDGET_MS
    next.preprocessTimeBudgetMs = TIME_BUDGET_MS
    next.maxNodes = Infinity

    // 逐步放开剪枝与截断，确保“被剪除的分支”也会被计算
    if (retry >= 1) {
      next.enableZeroExpandFilter = false
      next.minDeltaRatio = 0
      next.rareFreqRatio = 0
      next.rareFreqAbs = 0
      next.lbImproveMin = 0
      // 让调度器可以把束宽抬上去
      next.enableBeam = true
      next.beamWidth = Math.min(8192, Math.max(Number.isFinite(cur.beamWidth) ? cur.beamWidth : baseBeamWidth, baseBeamWidth) * 2)
      next.beamMin = Math.min(64, Math.max(Number.isFinite(cur.beamMin) ? cur.beamMin : baseBeamMin, baseBeamMin))
    }
    if (retry >= 2) {
      next.fullExpand = true
      next.disableStartPrune = true
      // 打破确定性：换不同顺序重新扫
      components.sort(() => Math.random() - 0.5)
    }
    if (retry >= 3) {
      // 彻底禁用 LB 剪枝（避免任何可能的过剪导致“无解”错判）
      next.enableLB = false
    }
    if (retry >= 4) {
      // 最终兜底：禁用束搜索（只保留排序，不再截断分支）
      next.enableBeam = false
    }

    try { self.SOLVER_FLAGS = { ...baseFlagsSnapshot, ...next } } catch {}
    try { onProgress?.({ phase:'retry_degrade', retry, elapsedMs: Date.now() - startTime, flags: { fullExpand: !!self.SOLVER_FLAGS?.fullExpand, enableLB: !!self.SOLVER_FLAGS?.enableLB, enableBeam: !!self.SOLVER_FLAGS?.enableBeam, beamWidth: self.SOLVER_FLAGS?.beamWidth, lbImproveMin: self.SOLVER_FLAGS?.lbImproveMin } }) } catch {}
    await new Promise(r=>setTimeout(r,0))
  }

  // 最终兜底：再次严格校验步数上限（acceptStepLimit），不满足则视为无合格解。
  // 但若启用了 near-miss 且找到了 +1 的近似解，则返回 nearMissPath 供前端展示（不算合格解）。
  if (best.minSteps!==Infinity && Number.isFinite(acceptStepLimit) && best.minSteps > acceptStepLimit) {
    if (ALLOW_NEAR_MISS && (bestNearMiss?.path || bestNearMiss2?.path)) {
      const nm = bestNearMiss?.path ? bestNearMiss : bestNearMiss2
      return { bestStartId: null, paths: [], minSteps: 0, timedOut: true, nearMiss: { bestStartId: nm.startId, path: nm.path, len: nm.path.length } }
    }
    return { bestStartId: null, paths: [], minSteps: 0, timedOut: true }
  }
  if(best.minSteps===Infinity) {
    if (ALLOW_NEAR_MISS && (bestNearMiss?.path || bestNearMiss2?.path)) {
      const nm = bestNearMiss?.path ? bestNearMiss : bestNearMiss2
      return { bestStartId: null, paths: [], minSteps: 0, timedOut: true, nearMiss: { bestStartId: nm.startId, path: nm.path, len: nm.path.length } }
    }
    return { bestStartId: null, paths: [], minSteps: 0, timedOut: true }
  }
  return { bestStartId: best.startId, paths: best.paths, minSteps: best.minSteps, timedOut }
}

// 方案后处理优化：对已统一颜色的路径进行反思、拆解与压缩
async function OptimizeSolution(triangles, palette, startId, path, onProgress){
  const OPT_FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : {}
  const TIME_BUDGET_MS = Number.isFinite(OPT_FLAGS?.optimizeTimeBudgetMs) ? Math.max(500, Math.min(180000, OPT_FLAGS.optimizeTimeBudgetMs)) : 120000
  const ENABLE_GLOBAL_SEARCH = (OPT_FLAGS?.optimizeEnableGlobalSearch !== false)
  const startTs = Date.now()
  const deadline = startTs + TIME_BUDGET_MS
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const neighbors = triangles.map(t=>t.neighbors)
  const originalPath = Array.isArray(path) ? path.slice() : []
  const isActionSteps = !!(originalPath && originalPath.length && originalPath[0] && typeof originalPath[0] === 'object')
  // 早停：路径超�?0，直接跳过优化，仅返回关键信�?
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

  const applyActionLocal = (colorsLocal, sid, color)=>{
    if (sid == null || !color) return null
    const idxS = idToIndex.get(sid)
    if (idxS==null) return null
    const triS = triangles[idxS]
    if (!triS || triS.deleted) return null
    const region = buildRegion(colorsLocal, sid)
    const next = colorsLocal.slice()
    for (const id of region) next[idToIndex.get(id)] = color
    // 扩张：并入相邻同色
    const q=[...region]
    const visited = new Uint8Array(triangles.length)
    for (const id of region){ const ii=idToIndex.get(id); if(ii!=null) visited[ii]=1 }
    while(q.length){
      const tid=q.shift()
      const idx=idToIndex.get(tid)
      for(const nb of neighbors[idx]){
        const nidx=idToIndex.get(nb)
        if(nidx==null) continue
        const tri=triangles[nidx]
        if(!visited[nidx] && !tri.deleted && tri.color!=='transparent' && next[nidx]===color){
          visited[nidx]=1
          q.push(nb)
        }
      }
    }
    // 注意：为了性能这里不重新构建 newRegion（后续 hub 计数会再次 buildRegion）
    return { colors: next }
  }

  const hubIds = (Array.isArray(OPT_FLAGS?.hubAnchorIds) && OPT_FLAGS.hubAnchorIds.length)
    ? Array.from(new Set(OPT_FLAGS.hubAnchorIds)).slice(0, 10)
    : ((Array.isArray(OPT_FLAGS?.focusAnchorIds) && OPT_FLAGS.focusAnchorIds.length)
      ? Array.from(new Set(OPT_FLAGS.focusAnchorIds)).slice(0, 10)
      : [])
  const internalIds = (Array.isArray(OPT_FLAGS?.internalBridgeIds) && OPT_FLAGS.internalBridgeIds.length)
    ? Array.from(new Set(OPT_FLAGS.internalBridgeIds)).slice(0, 24)
    : []

  const connectedHubCountLocal = (colorsLocal, sid)=>{
    if (!hubIds.length || sid==null) return 0
    let cnt = 0
    const region = buildRegion(colorsLocal, sid)
    for (const h of hubIds) { if (region.has(h)) cnt++ }
    return cnt
  }

  const globalBestHubCountLocal = (colorsLocal)=>{
    if (!hubIds.length) return 0
    let best = 0
    for (const h of hubIds) {
      if (h==null) continue
      const c = connectedHubCountLocal(colorsLocal, h)
      if (c > best) best = c
      if (best >= hubIds.length) break
    }
    return best
  }

  const getBoundaryAdjColorsLocal = (colorsArr, sid, cap=12)=>{
    try {
      const region = buildRegion(colorsArr, sid)
      if (!region || region.size===0) return []
      const idxS = idToIndex.get(sid)
      const curC = colorsArr[idxS]
      const set = new Set()
      for (const id of region) {
        const idx = idToIndex.get(id)
        for (const nb of neighbors[idx] || []) {
          const j = idToIndex.get(nb)
          if (j==null) continue
          const t = triangles[j]
          if (!t || t.deleted) continue
          const c2 = colorsArr[j]
          if (!c2 || c2==='transparent' || c2===curC) continue
          set.add(c2)
          if (set.size >= cap) break
        }
        if (set.size >= cap) break
      }
      return Array.from(set)
    } catch { return [] }
  }

  const isUniformAfterPath = (p)=>{
    let cc = triangles.map(t=>t.color)
    const act = !!(p && p.length && p[0] && typeof p[0] === 'object')
    for (const step of (p||[])) {
      const sid = act ? (step?.startId ?? startId) : startId
      const col = act ? step?.color : step
      if (sid==null || !col) continue
      const region = buildRegion(cc, sid)
      for (const id of region) cc[idToIndex.get(id)] = col
    }
    return isUniformFast(cc)
  }

  // 若当前路径不统一：不再早退，记录后跳过局部优化，直接进入全局重算阶段
  let tmpColors = colors.slice()
  for(const step of originalPath){
    const sid = (isActionSteps ? (step?.startId ?? startId) : startId)
    const stepColor = (isActionSteps ? step?.color : step)
    if (sid == null || !stepColor) continue
    const region = buildRegion(tmpColors, sid)
    for(const id of region){ tmpColors[idToIndex.get(id)] = stepColor }
  }
  const initiallyUniform = isUniformFast(tmpColors)
  if(!initiallyUniform){
    onProgress?.({ phase:'analysis', ok:false, reason:'path_not_unified' })
  }

  // 桥接段局部优化（专门为 action steps）：识别“桥接 hub 用了 >=3 步”的片段，强制尝试 2 步替代。
  // 目标：避免优化只在“慢扩张到另一侧 hub”的路线里微调，错过“从内部破局，两步打通”的更优桥接。
  const optimizeBridgeSegmentsActionSteps = (p)=>{
    if (!Array.isArray(p) || p.length < 4) return p
    if (!hubIds.length) return p
    const budgetMs = Number.isFinite(OPT_FLAGS?.optimizeBridgeBudgetMs) ? Math.max(20, Math.min(2000, OPT_FLAGS.optimizeBridgeBudgetMs)) : 220
    const startT = Date.now()
    const deadlineT = Math.min(deadline - 1200, startT + budgetMs)
    if (Date.now() > deadlineT) return p

    const paletteLocal = Array.isArray(palette) ? palette.filter(c=>c && c!=='transparent') : []
    const anchorPoolBase = Array.from(new Set([...(internalIds||[]), ...hubIds])).slice(0, 28)

    const simulatePrefix = (arr, uptoExclusive)=>{
      let cc = triangles.map(t=>t.color)
      for (let i=0;i<uptoExclusive;i++){
        const st = arr[i]
        const sid = st?.startId ?? startId
        const col = st?.color
        if (sid==null || !col) continue
        const r = applyActionLocal(cc, sid, col)
        if (!r) continue
        cc = r.colors
      }
      return cc
    }

    const findInefficientSegment = (arr)=>{
      // 用“全局最佳 hub 连通度”识别慢桥接：避免依赖某一步的 startId 造成漏判。
      let cc = triangles.map(t=>t.color)
      let lastBelow2 = 0
      let prevBest = globalBestHubCountLocal(cc)
      for (let i=0;i<arr.length;i++){
        const st = arr[i]
        const sid = st?.startId ?? startId
        const col = st?.color
        if (sid==null || !col) continue
        const r = applyActionLocal(cc, sid, col)
        if (!r) continue
        cc = r.colors
        const bestNow = globalBestHubCountLocal(cc)
        if (prevBest < 2) lastBelow2 = i
        if (prevBest < 2 && bestNow >= 2) {
          const segLen = i - lastBelow2 + 1
          if (segLen >= 3) return { j: lastBelow2, i, segLen }
        }
        prevBest = bestNow
      }
      return null
    }

    const tryReplaceWith2Steps = (cc0, windowAnchors)=>{
      // 穷举少量候选：anchor+边界相邻色优先
      let best = null
      const anchors = windowAnchors.slice(0, 24)
      for (const a1 of anchors) {
        if (Date.now() > deadlineT) break
        const adj1 = getBoundaryAdjColorsLocal(cc0, a1, 12)
        const colors1 = []
        for (const c of [...adj1, ...paletteLocal]) { if (c && c!=='transparent' && !colors1.includes(c)) { colors1.push(c); if (colors1.length>=12) break } }
        for (const c1 of colors1) {
          if (Date.now() > deadlineT) break
          const r1 = applyActionLocal(cc0, a1, c1)
          if (!r1) continue
          for (const a2 of anchors) {
            if (Date.now() > deadlineT) break
            const adj2 = getBoundaryAdjColorsLocal(r1.colors, a2, 12)
            const colors2 = []
            for (const c of [...adj2, ...paletteLocal]) { if (c && c!=='transparent' && c!==c1 && !colors2.includes(c)) { colors2.push(c); if (colors2.length>=12) break } }
            for (const c2 of colors2) {
              if (Date.now() > deadlineT) break
              const r2 = applyActionLocal(r1.colors, a2, c2)
              if (!r2) continue
              const hubNow = globalBestHubCountLocal(r2.colors)
              if (hubNow < 2) continue
              // 评分：优先 hubCnt，其次降低颜色种类（近似下界），再考虑“第二步是否仍在内部锚点上”
              const colorKinds = (()=>{ const s=new Set(); for(let k=0;k<triangles.length;k++){ const t=triangles[k]; const c=r2.colors[k]; if(!t.deleted && c && c!=='transparent') s.add(c) } return s.size })()
              const score = hubNow * 1000 - colorKinds * 6 - (internalIds.includes(a2) ? 0 : 8)
              if (!best || score > best.score) best = { score, steps: [{ startId: a1, color: c1 }, { startId: a2, color: c2 }] }
            }
          }
        }
      }
      return best
    }

    let cur = p.slice()
    let improved = false
    let passes = 0
    while (Date.now() <= deadlineT && passes < 3) {
      passes++
      const seg = findInefficientSegment(cur)
      if (!seg) break
      const { j, i } = seg
      // 在 j 状态上做 2 步替代搜索（窗口锚点：internal/hub + 原片段内出现过的 startId）
      const cc0 = simulatePrefix(cur, j)
      const segAnchors = []
      for (let k=j; k<=i; k++){ const sid = cur[k]?.startId; if (sid!=null) segAnchors.push(sid) }
      const windowAnchors = Array.from(new Set([...segAnchors, ...anchorPoolBase]))
      const best = tryReplaceWith2Steps(cc0, windowAnchors)
      if (!best) break
      const newPath = cur.slice(0, j).concat(best.steps, cur.slice(i+1))
      if (newPath.length >= cur.length) break
      if (!isUniformAfterPath(newPath)) {
        // 不破坏可行性：不接受
        break
      }
      cur = newPath
      improved = true
      onProgress?.({ phase:'optimize_bridge', improved:true, at:j, oldSegLen:(i-j+1), newSegLen:2, newLen:cur.length })
    }
    if (improved) onProgress?.({ phase:'optimize_bridge_done', improved:true, len:cur.length })
    return cur
  }

  // 多锚点 action steps：优先跑桥接段局部替代；再进入全局重算兜底。
  if (isActionSteps) {
    let p2 = originalPath
    try {
      if (initiallyUniform) p2 = optimizeBridgeSegmentsActionSteps(originalPath)
    } catch {}

    if (Array.isArray(p2) && p2.length < originalPath.length) {
      onProgress?.({ phase:'optimized', improved:true, reason:'bridge_segment_local', originalLen: originalPath.length, optimizedLen: p2.length })
      return { bestStartId: startId, optimizedPath: p2, originalLen: originalPath.length, optimizedLen: p2.length, shortened: true, analysis: { ok:true, action_steps:true, localBridge:true } }
    }

    if (!ENABLE_GLOBAL_SEARCH || (Date.now() > (deadline - 8000))) {
      onProgress?.({ phase:'optimized', improved: false, skippedGlobalSearch: true, reason:'action_steps_skip_local' })
      return { bestStartId: startId, optimizedPath: p2, originalLen: originalPath.length, optimizedLen: p2.length, shortened: p2.length < originalPath.length, analysis: { ok: initiallyUniform, skippedGlobalSearch: true, reason:'action_steps_skip_local' } }
    }
    const prevUseDFS = OPT_FLAGS.useDFSFirst
    const prevReturn = OPT_FLAGS.returnFirstFeasible
    try { self.SOLVER_FLAGS = { ...OPT_FLAGS, useDFSFirst: true, returnFirstFeasible: true } } catch {}
    const targetLimit = Math.max(0, p2.length - 1)
    let res = await Solver_minStepsAuto(triangles, palette, 3, (p)=>{ onProgress?.({ ...p, phase: p?.phase || 'optimize_search' }) }, targetLimit)
    try { self.SOLVER_FLAGS = { ...self.SOLVER_FLAGS, useDFSFirst: prevUseDFS, returnFirstFeasible: prevReturn } } catch {}
    if (res && res.paths && res.paths.length>0 && res.minSteps < p2.length) {
      onProgress?.({ phase:'optimized', improved: true, minSteps: res.minSteps })
      return { bestStartId: res.bestStartId ?? startId, optimizedPath: res.paths[0], originalLen: originalPath.length, optimizedLen: res.minSteps, shortened: true, analysis: { ok:true, action_steps:true } }
    }
    onProgress?.({ phase:'optimized', improved: false })
    return { bestStartId: startId, optimizedPath: p2, originalLen: originalPath.length, optimizedLen: p2.length, shortened: p2.length < originalPath.length, analysis: { ok: initiallyUniform, action_steps:true, localBridge: (p2.length < originalPath.length) } }
  }
  // 计算每一步的增益，识别关键节�?
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
  // 分组重排与压缩（桥接/边界/丰富�?
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
        // 计算窗口内“saddle”潜力（边界上颜�?color 的分量前两大之和�?
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
      // 生成若干候选：降序、升序、相邻交换组�?
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
  // 反思压缩：尝试移除低优先步骤（仍能统一颜色�?
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
  // 相邻交换的爬山（最多两轮）：若交换后更快降低下界或更易压缩则采�?
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
  const FLAGS = (typeof self !== 'undefined' && self.SOLVER_FLAGS) ? self.SOLVER_FLAGS : OPT_FLAGS
  // 全局重算阶段非常耗时：并行优化时允许缩小预算或直接关闭。
  if (!ENABLE_GLOBAL_SEARCH || (Date.now() > (deadline - 8000))) {
    onProgress?.({ phase:'optimized', improved: (path.length < originalPath.length), skippedGlobalSearch: true })
    return { bestStartId: startId, optimizedPath: path, originalLen: originalPath.length, optimizedLen: path.length, shortened: path.length < originalPath.length, analysis: { ok:true, skippedGlobalSearch: true } }
  }

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
    // 最终一致性校验：若优化后的路径不能统一颜色，则回退到原始路�?
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

// 进程内缓存：避免重复解析/重复赋值（但仍允许每次消息带入覆盖）
let _cachedTriangles = null
let _cachedPalette = null

// 进度节流：减少 postMessage 频率，降低通信与主线程处理开销
function createProgressThrottler(post, minIntervalMs = 40) {
  let lastTs = 0
  return (p, force = false) => {
    const now = Date.now()
    if (!force && (now - lastTs) < minIntervalMs) return
    lastTs = now
    try { post({ type: 'progress', payload: p }) } catch {}
  }
}

self.onmessage = async (e) => {
  const { type, triangles, palette, maxBranches, stepLimit, ragOptions, flags, preferredStartId } = e.data || {}
  // One-off PDB payload injection (intended for a small number of workers, e.g. strict threads)
  if (type === 'load_pdb') {
    const { key, obj } = e.data || {}
    try {
      const ok = !!(key && obj && typeof obj === 'object' && loadPDBObject(key, obj))
      self.postMessage({ type:'pdb_loaded', payload: { ok, key } })
    } catch (err) {
      self.postMessage({ type:'pdb_loaded', payload: { ok: false, key, error: String(err?.message || err) } })
    }
    return
  }
  // 支持在运行前设置或更�?flags（从主线程传入）
  if (type === 'set_flags') {
    try { self.SOLVER_FLAGS = { ...(self.SOLVER_FLAGS||{}), ...(flags||{}) } } catch {}
    self.postMessage({ type:'flags_set', payload: { ok: true } })
    return
  }
  // 可选初始化：把 puzzle 状态缓存到 worker 内，后续 auto/optimize 可省略 triangles/palette
  if (type === 'init') {
    if (Array.isArray(triangles)) _cachedTriangles = triangles
    if (Array.isArray(palette)) _cachedPalette = palette
    self.postMessage({ type: 'init_done', payload: { ok: true, triangles: Array.isArray(_cachedTriangles) ? _cachedTriangles.length : 0, palette: Array.isArray(_cachedPalette) ? _cachedPalette.length : 0 } })
    return
  }
  if(type==='auto'){
    const tris = Array.isArray(triangles) ? triangles : _cachedTriangles
    const pal = Array.isArray(palette) ? palette : _cachedPalette
    if (!Array.isArray(tris) || !Array.isArray(pal)) {
      self.postMessage({ type:'result', payload: { bestStartId: null, paths: [], minSteps: 0, timedOut: false, error: 'missing_triangles_or_palette' } })
      return
    }
    // 若提供了优先起点，将其所在分量优先处�?
    if (preferredStartId!=null && Array.isArray(tris)) {
      try {
        const idxMap = new Map(tris.map((t,i)=>[t.id,i]))
        const targetIdx = idxMap.get(preferredStartId)
        if (targetIdx!=null) {
          // 轻量标记：通过全局 flags 传递优先起点，供自动解排序阶段使用
          self.SOLVER_FLAGS = { ...(self.SOLVER_FLAGS||{}), preferredStartId }
        }
      } catch {}
    }
    const postProgress = createProgressThrottler((msg)=> self.postMessage(msg), (self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.progressPostIntervalMs)) ? Math.max(0, self.SOLVER_FLAGS.progressPostIntervalMs) : 40)
    const forcePhases = new Set(['solution','best_update','components_done','parallel_solved','cache_hit','optimized','optimized_invalid','error'])
    const result = await Solver_minStepsAuto(tris, pal, maxBranches, (p)=>{
      const ph = p?.phase
      const force = forcePhases.has(ph)
      postProgress(p, force)
    }, stepLimit)
    // 保持向后兼容：仅在存�?ragOptions 时，附带回传，便于调�?
    const payload = ragOptions ? { ...result, ragPlan: { enabled: !!ragOptions?.enable } } : result
    self.postMessage({ type:'result', payload })
  } else if(type==='optimize'){
    const tris = Array.isArray(triangles) ? triangles : _cachedTriangles
    const pal = Array.isArray(palette) ? palette : _cachedPalette
    if (!Array.isArray(tris) || !Array.isArray(pal)) {
      self.postMessage({ type:'result', payload: { bestStartId: null, optimizedPath: null, originalLen: 0, optimizedLen: 0, shortened: false, analysis: { ok: false, reason: 'missing_triangles_or_palette' } } })
      return
    }
    const { startId, path } = e.data || {}
    const postProgress = createProgressThrottler((msg)=> self.postMessage(msg), (self.SOLVER_FLAGS && Number.isFinite(self.SOLVER_FLAGS.progressPostIntervalMs)) ? Math.max(0, self.SOLVER_FLAGS.progressPostIntervalMs) : 40)
    const forcePhases = new Set(['optimized','optimized_invalid','error'])
    const result = await OptimizeSolution(tris, pal, startId, path, (p)=>{
      const ph = p?.phase
      postProgress(p, forcePhases.has(ph))
    })
    self.postMessage({ type:'result', payload: result })
  }
}

