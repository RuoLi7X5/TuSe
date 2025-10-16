import { isUniform, buildRAG, colorFrequency } from './grid-utils'
import { getHeuristic } from './heuristics'
import { partitionBlocks, planBlockAStar } from './blocking'
import { mctsSolve } from './mcts'
import { satMacroColorPlan } from './sat'
import { UCBColorPrioritizer } from './learn'
import { localRepair } from './local-repair'
import { bitsetAlloc, bitsetClone, bitsetSet, bitsetHas, bitsetOr, bitsetCount, bitsetToIds } from './bitset'

export function floodFillRegion(triangles, startId, targetColor) {
  const startColor = triangles.find(t => t.id === startId)?.color
  const startDeleted = triangles.find(t => t.id === startId)?.deleted || startColor === 'transparent'
  if (!startColor || startColor === targetColor || startDeleted) {
    return { newColors: triangles.map(t => t.color), changedIds: [] }
  }
  const visited = new Set([startId])
  const queue = [startId]
  const region = []
  const idToIndex = new Map(triangles.map((t, i) => [t.id, i]))
  while (queue.length) {
    const id = queue.shift()
    const t = triangles[idToIndex.get(id)]
    if (t.deleted || t.color === 'transparent' || t.color !== startColor) continue
    region.push(id)
    for (const nb of t.neighbors) {
      if (!visited.has(nb)) { visited.add(nb); queue.push(nb) }
    }
  }
  const newColors = triangles.map(t => region.includes(t.id) ? targetColor : t.color)
  return { newColors, changedIds: region }
}

function keyFromColors(colors){
  return colors.join(',')
}

export function attachSolverToWindow(){
  window.Solver_minSteps = async function(triangles, startId, palette, maxBranches=3, onProgress, stepLimit=Infinity){
    const startTime = Date.now()
    // 固定计算时限：5 分钟（300000 ms）
    const TIME_BUDGET_MS = 300000
    let timedOut = false
    const startColor = triangles.find(t=>t.id===startId)?.color
    const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
    const neighbors = triangles.map(t=>t.neighbors)

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
    // Transposition table: track min(g) and min(f) per state
    const seenBestG = new Map([[startKey, 0]])
    const globalTT = new Map([[startKey, { gMin: 0, fMin: 0 }]])
    // 动态上限：随网格大小调整，避免爆炸
    const maxNodes = Math.min(20000, Math.max(8000, triangles.length * 8))
    const queueStates = [{ colors:startColors, region: new Set(region), steps: [] }]
    const solutions = []
    // 可选开关（默认关闭）：从全局覆写
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    const ENABLE_LB = !!FLAGS.enableLB
    const ENABLE_LOOKAHEAD = !!FLAGS.enableLookahead
    const ENABLE_LOOKAHEAD2 = !!FLAGS.enableLookaheadDepth2
    const ENABLE_INCREMENTAL = !!FLAGS.enableIncremental
    const ENABLE_BEAM = !!FLAGS.enableBeam
    const BEAM_WIDTH = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
    const ENABLE_BEST_FIRST = !!FLAGS.enableBestFirst
    // 若启用 Best-First，默认采用 A* 排序（可通过 useAStarInBestFirst 显式关闭）
    const ENABLE_ASTAR_BF = Object.prototype.hasOwnProperty.call(FLAGS, 'useAStarInBestFirst')
      ? !!FLAGS.useAStarInBestFirst
      : !!ENABLE_BEST_FIRST
    const ENABLE_BRIDGE_FIRST = !!FLAGS.enableBridgeFirst
    const ADJ_AFTER_WEIGHT = Number.isFinite(FLAGS?.adjAfterWeight) ? FLAGS.adjAfterWeight : 0.6
    const BRIDGE_WEIGHT = Number.isFinite(FLAGS?.bridgeWeight) ? FLAGS.bridgeWeight : 1.0
    const GATE_WEIGHT = Number.isFinite(FLAGS?.gateWeight) ? FLAGS.gateWeight : 0.4
    const RICHNESS_WEIGHT = Number.isFinite(FLAGS?.richnessWeight) ? FLAGS.richnessWeight : 0.5
    const BOUNDARY_WEIGHT = Number.isFinite(FLAGS?.boundaryWeight) ? FLAGS.boundaryWeight : 0.8
    const USE_STRICT_LB_BF = !!FLAGS.strictMode || !!FLAGS.useStrongLBInBestFirst
    // 新增开关：零扩张候选过滤与性能日志
    const ENABLE_ZERO_FILTER = (FLAGS.enableZeroExpandFilter !== false)
    const LOG_PERF = !!FLAGS.logPerf
    // 稀有颜色与“准零扩张”/下界改进的过滤阈值（可调）
    const RARE_FREQ_RATIO = Number.isFinite(FLAGS?.rareFreqRatio) ? FLAGS.rareFreqRatio : 0.03
    const RARE_FREQ_ABS = Number.isFinite(FLAGS?.rareFreqAbs) ? FLAGS.rareFreqAbs : 3
    const RARE_ALLOW_BRIDGE_MIN = Number.isFinite(FLAGS?.rareAllowBridgeMin) ? FLAGS.rareAllowBridgeMin : 2.0
    const RARE_ALLOW_GATE_MIN = Number.isFinite(FLAGS?.rareAllowGateMin) ? FLAGS.rareAllowGateMin : 1.0
    const MIN_DELTA_RATIO = Number.isFinite(FLAGS?.minDeltaRatio) ? FLAGS.minDeltaRatio : 0.02
    const LB_IMPROVE_MIN = Number.isFinite(FLAGS?.lbImproveMin) ? FLAGS.lbImproveMin : 1
    // 3类×3维权重（默认值）
    const REGION_CLASS_WEIGHTS = FLAGS?.regionClassWeights || { boundary: 0.8, bridge: 1.0, richness: 0.6 }
    const DIM_WEIGHTS = FLAGS?.dimensionWeights || { expand: 1.0, connect: 0.8, barrier: 0.7 }

    // 构建一次 RAG 与全局颜色频次，供桥接启发式使用
    const RAG = buildRAG(triangles)
    const FREQ = colorFrequency(triangles)
    // 颜色集中度偏置（不依赖面积）：按 RAG 组件计数构建简单偏置
    const COLOR_COMP_COUNT = new Map()
    for(const comp of RAG.components){ const c = comp.color; if(c){ COLOR_COMP_COUNT.set(c,(COLOR_COMP_COUNT.get(c)||0)+1) } }
    const getColorBias = (c)=> 1 / Math.max(1, (COLOR_COMP_COUNT.get(c)||1))

    function computeAdjAfterSize(color, curColors, regionSet){
      // 预演一步应用 color 后的新区域相邻颜色种类数
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

    function computeBridgePotential(color, curColors, regionSet){
      // 估计打通到高扩张性组件的潜力（使用 RAG 缓存）
      try{
        const tmp = curColors.slice()
        for(const id of regionSet){ tmp[idToIndex.get(id)] = color }
        // 构建一步后的新区域成员集合
        const newRegion = new Set([...regionSet])
        const q=[...regionSet]; const visited2=new Set([...regionSet])
        while(q.length){
          const tid=q.shift(); const idx=idToIndex.get(tid)
          for(const nb of neighbors[idx]){
            const nidx=idToIndex.get(nb); if(nidx==null) continue
            const tri=triangles[nidx]; const cc=tmp[nidx]
            if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && cc===color){ visited2.add(nb); newRegion.add(nb); q.push(nb) }
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
            if(cj!=null){
              seenComps.add(cj)
              gateContacts.set(cj, (gateContacts.get(cj)||0)+1)
            }
          }
        }
        let bridgePotential = 0
        let gateScore = 0
        for(const compId of seenComps){
          const comp = RAG.components[compId]
          if(!comp) continue
          const bd = RAG.boundaryDegree[compId] || 0
          // 邻近颜色多样性估计：组件邻接的不同颜色计数
          const adjComps = RAG.compAdj[compId] || []
          const adjColorSet = new Set()
          for(const aj of adjComps){ const co = RAG.components[aj]; if(co && co.color){ adjColorSet.add(co.color) } }
          const neighborVariety = adjColorSet.size
          // 去面积化：不再使用 size，强调边界与邻色多样性
          const richness = bd * 0.7 + neighborVariety * 1.3
          bridgePotential += richness
          const contacts = gateContacts.get(compId) || 0
          // 窄缝奖励：接触点少但组件边界度高，视为“打通价值高”
          gateScore += (bd>0 ? (bd / (contacts+1)) : 0)
        }
        return { bridgePotential: bridgePotential * RICHNESS_WEIGHT, gateScore }
      } catch { return { bridgePotential: 0, gateScore: 0 } }
    }
    const lbCache = new Map()
    function lowerBound(colors){
      // 估计至少需要的步数：当前不同颜色数 - 1（过滤删除/透明）
      const key = keyFromColors(colors)
      const cached = lbCache.get(key)
      if (cached!=null) return cached
      const s = new Set()
      for(let i=0;i<triangles.length;i++){
        const t = triangles[i]; const c = colors[i]
        if(!t.deleted && c && c !== 'transparent') s.add(c)
      }
      const lb = Math.max(0, s.size - 1)
      lbCache.set(key, lb)
      return lb
    }

    function boundaryDistinct(colors, regionSet){
      const rc = colors[idToIndex.get(startId)]
      const set = new Set()
      for(const tid of regionSet){
        const idx=idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx=idToIndex.get(nb); if(nidx==null) continue
          const tri=triangles[nidx]; const c=colors[nidx]
          if(c!==rc && c && c!=='transparent' && !tri.deleted){ set.add(c) }
        }
      }
      return set.size
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

    let nodes = 0
    let maxDepth = 0
    const perf = {
      filteredZero: 0,
      expanded: 0,
      enqueued: 0,
      lbHist: { improve0: 0, improve1_2: 0, improve3_5: 0, improve6p: 0 },
      queueMax: 0,
      depthMax: 0
    }
    while(queueStates.length && nodes<maxNodes){
      // 时间预算：定期让出事件循环，避免页面无响应
      if (nodes % 300 === 0) {
        // 超时则中止，返回已找到的最短分支
        if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break }
        await new Promise(r=>setTimeout(r,0))
        if (onProgress) {
          perf.queueMax = Math.max(perf.queueMax, queueStates.length)
          perf.depthMax = Math.max(perf.depthMax, maxDepth)
          try { onProgress({ phase: 'search', nodes, queue: queueStates.length, solutions: solutions.length, elapsedMs: Date.now() - startTime, maxDepth, perf }) } catch {}
        }
      }
      const cur = queueStates.shift(); nodes++
      const curColors = cur.colors
      // 剪枝：超过步数上限不再扩展
      if (cur.steps.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
        continue
      }
      // LB 早停：若剩余下界超过可用步数则剪枝
      if (ENABLE_LB && Number.isFinite(stepLimit)){
        const lb = USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, cur.region) : lowerBound(curColors)
        if (cur.steps.length + lb > stepLimit) {
          continue
        }
      }
      // 完成
      if(isUniform(curColors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))){
        // 若开启“先返回可行解”，立即返回当前路径（可能不是全局最短）
        if ((typeof window !== 'undefined' && window.SOLVER_FLAGS?.returnFirstFeasible) && Number.isFinite(stepLimit)) {
          if (onProgress) {
            try { onProgress({ phase: 'solution', minSteps: cur.steps.length, solutions: 1, elapsedMs: Date.now() - startTime }) } catch {}
          }
          return { paths: [cur.steps], minSteps: cur.steps.length, timedOut }
        }
        solutions.push(cur.steps)
        // BFS 保证最短，收集所有同长分支（受 maxBranches 限制）
        const minLen = solutions[0].length
        const sameLen = solutions.filter(s=>s.length===minLen)
        if (onProgress) {
          try { onProgress({ phase: 'solution', minSteps: minLen, solutions: sameLen.length, elapsedMs: Date.now() - startTime }) } catch {}
        }
        if(sameLen.length>=maxBranches) break
        else continue
      }
      const regionSet = cur.region
      const regionColor = curColors[idToIndex.get(startId)]

      // 仅尝试与当前区域相邻的可行颜色，减少无效分支；并统计每个颜色的潜在增益
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
      // 预筛选 + 边界聚类启发式：先按增益挑前 K，再估计同色连通聚类规模，减少无效尝试
      const colorCount = new Map()
      for(const t of triangles){
        if(!t.deleted && t.color && t.color!=='transparent'){
          colorCount.set(t.color, (colorCount.get(t.color)||0)+1)
        }
      }
      const tryColorsRaw = adjColors.size>0 ? [...adjColors] : palette
      const boundaryBefore = boundaryDistinct(curColors, regionSet)
      const basePreK = Math.max(4, Math.min(8, 4 + Math.floor((adjColors.size||0)/3) + (boundaryBefore>6?2:0)))
      const depth = cur.steps.length
      const beamBase = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
      const beamDecay = Number.isFinite(FLAGS?.beamDecay) ? FLAGS.beamDecay : 0.85
      const beamMin = Number.isFinite(FLAGS?.beamMin) ? FLAGS.beamMin : 4
      const pressure = Math.min(1, (Array.isArray(queueStates) ? queueStates.length : 0) / Math.max(1, maxNodes))
      const pressureScale = ENABLE_BEAM ? Math.max(0.6, 1.0 - 0.5*pressure) : 1.0
      const dynamicWidth = ENABLE_BEAM ? Math.max(beamMin, Math.floor(beamBase * Math.pow(beamDecay, depth) * pressureScale)) : beamBase
      const preK = ENABLE_BEAM ? Math.min(dynamicWidth, basePreK) : basePreK
      // 初始颜色统计与离散度（基于初始三角图，不随搜索变化）
      const compCount = new Map()
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
      const colorSize = colorCount
      const getDispersion = (c)=> (compCount.get(c)||0) / Math.max(1, (colorSize.get(c)||1))
      const DISP_W = Number.isFinite(FLAGS?.dispersionWeight) ? FLAGS.dispersionWeight : 0.6
      const prelim = tryColorsRaw.map(c=>{
        const g = (gain.get(c)||0)
        const score0 = g*3 + getBiasStrict(c) + getDispersion(c)*DISP_W
        return { c, score0, gain:g }
      }).sort((a,b)=> b.score0 - a.score0).slice(0, preK)

      // 边界同色聚类规模估计：从区域边界与颜色 c 的接触点出发，仅在 c 内扩张
      const regionBoundaryNeighbors = []
      for(const tid of regionSet){
        const idx = idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx = idToIndex.get(nb)
          if (nidx==null) continue
          if (curColors[nidx] !== regionColor){
            regionBoundaryNeighbors.push(nb)
          }
        }
      }
      const enlargePotential = new Map()
      for(const {c} of prelim){
        const seeds = []
        for(const nb of regionBoundaryNeighbors){
          const nbIdx = idToIndex.get(nb)
          if (nbIdx!=null && curColors[nbIdx]===c){ seeds.push(nb) }
        }
        // 非面积扩张潜力：边界同色种子数量 + 种子连通性（分量越少越好）
        const seedSet = new Set(seeds)
        const visitedB = new Set()
        let compCountB = 0
        for(const s of seeds){
          if(visitedB.has(s)) continue
          compCountB += 1
          const qB=[s]; visitedB.add(s)
          while(qB.length){
            const u=qB.shift()
            const uIdx=idToIndex.get(u)
            for(const v of neighbors[uIdx]){
              const vIdx=idToIndex.get(v)
              if(vIdx==null) continue
              if(seedSet.has(v) && !visitedB.has(v) && curColors[vIdx]===c){ visitedB.add(v); qB.push(v) }
            }
          }
        }
        const boundarySeedCount = seeds.length
        enlargePotential.set(c, boundarySeedCount * 1.0 + Math.max(0, boundarySeedCount - compCountB) * 0.5)
      }
      // 双前沿“saddle”潜力：统计边界上颜色 c 的连通分量数量与最大的两个分量规模之和
      const saddlePotential = new Map()
      for(const {c} of prelim){
        const seeds = []
        for(const nb of regionBoundaryNeighbors){
          const nbIdx = idToIndex.get(nb)
          if (nbIdx!=null && curColors[nbIdx]===c){ seeds.push(nb) }
        }
        const visited = new Set()
        const compSizes = []
        for(const s of seeds){
          if (visited.has(s)) continue
          let size = 0
          const q=[s]; visited.add(s)
          while(q.length){
            const u=q.shift(); size++
            const uIdx = idToIndex.get(u)
            for(const v of neighbors[uIdx]){
              const vIdx = idToIndex.get(v)
              if (vIdx==null) continue
              if (!visited.has(v) && curColors[vIdx]===c){ visited.add(v); q.push(v) }
            }
          }
          compSizes.push(size)
        }
        compSizes.sort((a,b)=>b-a)
        // 非面积“saddle”：以分量数量衡量多前沿潜力
        saddlePotential.set(c, compSizes.length)
      }
      const baseLimitTry = Math.max(6, Math.min(10, 6 + Math.floor((adjColors.size||0)/3) + (boundaryBefore>6?2:0)))
      let limitTry = ENABLE_BEAM ? Math.min(dynamicWidth, baseLimitTry) : baseLimitTry
      const prevLB = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, regionSet) : lowerBound(curColors)) : 0
      const BF_W = Number.isFinite(window?.SOLVER_FLAGS?.bifrontWeight) ? window.SOLVER_FLAGS.bifrontWeight : 2.0
      // 学习驱动优先级（UCB bandit）：在候选排序中加入学习项
      const LEARN = (typeof window !== 'undefined' && window.SOLVER_FLAGS && window.SOLVER_FLAGS.enableLearningPrioritizer) ? (window.__UCB_PRIOR__ || (window.__UCB_PRIOR__ = new UCBColorPrioritizer(palette))) : null
      const scored = prelim
        .map(({c, gain})=>{
          const pot = (enlargePotential.get(c)||0)
          const saddle = (saddlePotential.get(c)||0)
          let score = gain*3 + pot*2 + saddle*BF_W + getColorBias(c)
          if (LEARN) { score += LEARN.ucb(c) * 1.25 }
          if (ENABLE_LOOKAHEAD){
            // 一步预演：应用颜色后计算下界变化，倾向于降低下界的颜色
          const tmp = curColors.slice()
          for(const id of regionSet) tmp[idToIndex.get(id)] = c
          let lb1 = 0
          if (ENABLE_LB){
            if (USE_STRICT_LB_BF){
              const q1=[...regionSet]; const v1=new Set([...regionSet]); const newRegion1=new Set([...regionSet])
              while(q1.length){ const tid=q1.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!v1.has(nb) && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===c){ v1.add(nb); newRegion1.add(nb); q1.push(nb) } } }
              lb1 = lowerBoundStrictLocal(tmp, newRegion1)
            } else {
              lb1 = lowerBound(tmp)
            }
          }
          score += (prevLB - lb1) * 4 - lb1 * 1
        }
          if (ENABLE_LOOKAHEAD2){
            // 两步预演：在一步后的临时状态上，估计下一步对下界的进一步降低
            const tmp = curColors.slice()
            for(const id of regionSet) tmp[idToIndex.get(id)] = c
            // 扩张得到临时新区域（在颜色 c 内）
            const q=[...regionSet]; const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 } const newRegionTmp=new Set([...regionSet])
            while(q.length){
              const tid=q.shift(); const idx=idToIndex.get(tid)
              for(const nb of neighbors[idx]){
                const nidx=idToIndex.get(nb); const tri=triangles[nidx]
                if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===c){ visited2[nidx]=1; newRegionTmp.add(nb); q.push(nb) }
              }
            }
            const lb1 = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(tmp, newRegionTmp) : lowerBound(tmp)) : 0
            // 计算第二步的邻接与候选（限制很小的K以控制开销）
            const adj2=new Set(); const gain2=new Map()
            for(const tid of newRegionTmp){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=tmp[nidx]; if(cc!==c && cc && cc!=='transparent' && !tri.deleted){ adj2.add(cc); gain2.set(cc,(gain2.get(cc)||0)+1) } } }
            const raw2 = adj2.size>0 ? [...adj2] : palette
            const preK2 = 4
            const prelim2 = raw2.map(c2=>({ c2, g:(gain2.get(c2)||0), f:(colorCount.get(c2)||0) }))
              .map(({c2,g})=>({ c2, score0: g*3 + getColorBias(c2) }))
              .sort((a,b)=>b.score0-a.score0)
              .slice(0, preK2)
            let bestLb2 = lb1
            for(const {c2} of prelim2){
              const tmp2 = tmp.slice()
              for(const id of newRegionTmp) tmp2[idToIndex.get(id)] = c2
              const lb2 = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(tmp2, newRegionTmp) : lowerBound(tmp2)) : 0
              if(lb2 < bestLb2) bestLb2 = lb2
            }
            score += (prevLB - lb1) * 3 + (lb1 - bestLb2) * 2
          }
          if (ENABLE_BRIDGE_FIRST){
            const adjAfter = computeAdjAfterSize(c, curColors, regionSet)
            const { bridgePotential, gateScore } = computeBridgePotential(c, curColors, regionSet)
            const boundaryAfter = adjAfter
            score += (boundaryBefore - boundaryAfter) * BOUNDARY_WEIGHT
            score += adjAfter * ADJ_AFTER_WEIGHT + bridgePotential * BRIDGE_WEIGHT + gateScore * GATE_WEIGHT
          }
          return { c, score }
        })
        .sort((a,b)=> b.score - a.score)
        .map(x=>({ c:x.c, score:x.score }))
      // LB 改进驱动的 Beam 扩宽：根据候选中最大下界改进比例适度扩宽
      let maxImprove = 0
      if (ENABLE_LB){
        for(const {c} of prelim){
          const tmp=curColors.slice(); for(const id of regionSet) tmp[idToIndex.get(id)] = c
          const q=[...regionSet]; const newRegion=new Set([...regionSet]); const visited2=new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===c){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } } }
          const lb1 = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(tmp, newRegion) : lowerBound(tmp)) : 0
          const improve = Math.max(0, prevLB - lb1)
          maxImprove = Math.max(maxImprove, prevLB>0 ? improve/prevLB : 0)
        }
      }
      const widen = ENABLE_BEAM ? Math.min(0.5, maxImprove) : 0
      limitTry = Math.min(tryColorsRaw.length, Math.max(limitTry, Math.floor(limitTry * (1 + widen))))
      const tryColors = scored.slice(0, limitTry).map(x=>x.c)
      for(const color of tryColors){
        if(color===regionColor) continue
        // 应用颜色
        const nextColors = curColors.slice()
        for(const id of regionSet) nextColors[idToIndex.get(id)] = color
        const key = keyFromColors(nextColors)
        const gNext = nextSteps.length
        // TT：按最小 g 剪枝（若已以更短或相同步数到达该颜色组合）
        const prevG = seenBestG.get(key)
        if (prevG != null && prevG <= gNext) { continue }
        // 新区域（与共享边同色扩张）
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
        if (LEARN) {
          const delta = (newRegion.size - regionSet.size) / Math.max(1, regionSet.size)
          const prevLB = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, regionSet) : lowerBound(curColors)) : 0
          const lb1 = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(nextColors, newRegion) : lowerBound(nextColors)) : 0
          const reward = Math.max(0, (prevLB - lb1) * 0.5 + delta)
          try { LEARN.record(color, reward) } catch {}
        }
        if (nextSteps.length > maxDepth) maxDepth = nextSteps.length
        if (nextSteps.length <= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
          // 过滤：零扩张候选（应用颜色后区域未增长）
          const delta = newRegion.size - regionSet.size
          if (ENABLE_ZERO_FILTER && delta <= 0) { perf.filteredZero++; continue }
          // 准零扩张：相对增长过小则跳过（避免“几乎没用”的动作）
          const deltaRatio = delta / Math.max(1, regionSet.size)
          if (deltaRatio < MIN_DELTA_RATIO) { continue }
          // 稀有颜色过滤：全局出现很少且桥接/窄缝价值不显著时跳过
          const freq = (colorCount.get(color) || 0)
          const rareTh = Math.max(RARE_FREQ_ABS, Math.floor(triangles.length * RARE_FREQ_RATIO))
          if (freq < rareTh) {
            const { bridgePotential, gateScore } = computeBridgePotential(color, nextColors, newRegion)
            if (bridgePotential < RARE_ALLOW_BRIDGE_MIN && gateScore < RARE_ALLOW_GATE_MIN) {
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
          // 子状态优先级（Best-First/Beam 骨架），使用基础启发式与下界
          let baseScore = (gain.get(color)||0)*3 + (colorCount.get(color)||0)*0.5 + (enlargePotential.get(color)||0)*2
          if (ENABLE_BRIDGE_FIRST){
            const adjAfter = computeAdjAfterSize(color, nextColors, newRegion)
            const { bridgePotential, gateScore } = computeBridgePotential(color, nextColors, newRegion)
            const boundaryAfter = adjAfter
            baseScore += (boundaryBefore - boundaryAfter) * BOUNDARY_WEIGHT
            baseScore += adjAfter * ADJ_AFTER_WEIGHT + bridgePotential * BRIDGE_WEIGHT + gateScore * GATE_WEIGHT
            // 3类×3维综合加权
            const expandPart = adjAfter * (DIM_WEIGHTS.expand || 1)
            const connectPart = (bridgePotential + gateScore) * (DIM_WEIGHTS.connect || 0.8)
            const barrierPart = (boundaryBefore - boundaryAfter) * (DIM_WEIGHTS.barrier || 0.7)
            baseScore += expandPart * (REGION_CLASS_WEIGHTS.boundary || 0.8)
            baseScore += connectPart * (REGION_CLASS_WEIGHTS.bridge || 1.0)
            baseScore += barrierPart * (REGION_CLASS_WEIGHTS.boundary || 0.8)
          }
          const childLB = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(nextColors, newRegion) : lowerBound(nextColors)) : 0
          // 下界改进不足：若一步后下界几乎不降，则跳过
          if (ENABLE_LB && (prevLB - childLB) < LB_IMPROVE_MIN) { continue }
          if (ENABLE_LB) {
            const improve = Math.max(0, prevLB - childLB)
            if (improve <= 0) perf.lbHist.improve0++
            else if (improve <= 2) perf.lbHist.improve1_2++
            else if (improve <= 5) perf.lbHist.improve3_5++
            else perf.lbHist.improve6p++
          }
          const fNext = gNext + childLB
          // TT：按最小 f 剪枝（若已以更小或相同 f 到达该颜色组合）
          const prevTT = globalTT.get(key)
          if (prevTT && ((prevTT.gMin ?? Infinity) <= gNext || (prevTT.fMin ?? Infinity) <= fNext)) { continue }
          const priority = baseScore - childLB * 2
          queueStates.push({ colors: nextColors, region: newRegion, steps: nextSteps, boundaryNeighbors: nextBoundaryNeighbors, priority, g: gNext, h: childLB, f: fNext })
          // 更新 TT 记录
          const gMin = Math.min(prevTT?.gMin ?? Infinity, gNext)
          const fMin = Math.min(prevTT?.fMin ?? Infinity, fNext)
          globalTT.set(key, { gMin, fMin })
          seenBestG.set(key, gNext)
          perf.enqueued++
          perf.expanded += Math.max(0, delta)
        }
      }
      if (ENABLE_BEST_FIRST) {
        perf.queueMax = Math.max(perf.queueMax, queueStates.length)
        if (ENABLE_ASTAR_BF) {
          // A*：按 f=g+h 升序排序，优先更小 f；同 f 以启发式优先级打破Tie
          queueStates.sort((a,b)=>{
            const df = (a.f ?? Infinity) - (b.f ?? Infinity)
            if (df !== 0) return df
            return (b.priority ?? -Infinity) - (a.priority ?? -Infinity)
          })
        } else {
          // 传统 Best-First：按启发式优先级排序
          queueStates.sort((a,b)=> (b.priority ?? -Infinity) - (a.priority ?? -Infinity))
        }
      }
    }
    if(solutions.length===0){
      // Fallback：若设置了步数上限，使用深度受限 DFS 在上限内寻找统一解
      if (Number.isFinite(stepLimit)) {
    const seenDepth = new Map([[keyFromColors(startColors), 0]])
        const buildRegion = (colors) => {
          const startColorCur = colors[idToIndex.get(startId)]
          const rs = new Set()
          const q=[startId]; const v=new Set([startId])
          while(q.length){
            const id=q.shift(); const idx=idToIndex.get(id)
            if(colors[idx]!==startColorCur) continue
            rs.add(id)
            for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } }
          }
          return rs
        }
        const orderColors = (colors, regionSet) => {
          const regionColor2 = colors[idToIndex.get(startId)]
          const adjColors = new Set(); const gain=new Map()
          for(const tid of regionSet){
            const idx=idToIndex.get(tid)
            for(const nb of neighbors[idx]){
              const nidx=idToIndex.get(nb)
              const tri=triangles[nidx]
              const c=colors[nidx]
              if(c!==regionColor2 && c && c!=='transparent' && !tri.deleted){ adjColors.add(c); gain.set(c,(gain.get(c)||0)+1) }
            }
          }
          const raw = adjColors.size>0 ? [...adjColors] : palette
          const score=(c)=>{
            let s = (gain.get(c)||0)*3 + getColorBias(c)
            if (ENABLE_BRIDGE_FIRST){
              const adjAfter = computeAdjAfterSize(c, colors, regionSet)
              const { bridgePotential, gateScore } = computeBridgePotential(c, colors, regionSet)
              s += adjAfter * ADJ_AFTER_WEIGHT + bridgePotential * BRIDGE_WEIGHT + gateScore * GATE_WEIGHT
              // 3类×3维综合加权
              const expandPart = adjAfter * (DIM_WEIGHTS.expand || 1)
              const connectPart = (bridgePotential + gateScore) * (DIM_WEIGHTS.connect || 0.8)
              s += expandPart * (REGION_CLASS_WEIGHTS.boundary || 0.8)
              s += connectPart * (REGION_CLASS_WEIGHTS.bridge || 1.0)
            }
            return s
          }
          return raw.sort((a,b)=>score(b)-score(a)).slice(0,8).filter(c=>c!==regionColor2)
        }
        const startTs = Date.now()
        async function dfs(colors, regionSet, steps){
          // 完成
          if(isUniform(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))) return steps
          if(steps.length>=stepLimit) return null
          if(Date.now()-startTs > TIME_BUDGET_MS) return null
          const tryColors = orderColors(colors, regionSet)
          for(const color of tryColors){
            const nextColors = colors.slice()
            for(const id of regionSet) nextColors[idToIndex.get(id)] = color
        const key = keyFromColors(nextColors)
        // 在 DFS 回退分支中，深度应基于当前递归的 steps 数量，而非 BFS 的 cur
        const nextDepth = steps.length + 1
        const sd = seenDepth.get(key)
        if(sd!=null && sd <= nextDepth) continue
        seenDepth.set(key, nextDepth)
            // 新区域在 nextColors 上扩张
            const q=[...regionSet]; const visited2=new Set([...regionSet]); const newRegion=new Set([...regionSet])
            while(q.length){
              const tid=q.shift(); const idx=idToIndex.get(tid)
              for(const nb of neighbors[idx]){
                const nidx=idToIndex.get(nb); const tri=triangles[nidx]
                if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2.add(nb); newRegion.add(nb); q.push(nb) }
              }
            }
            const res = await dfs(nextColors, newRegion, [...steps,color])
            if(res) return res
            await new Promise(r=>setTimeout(r,0))
          }
          return null
        }
        const dfsRegion = buildRegion(startColors)
        const dfsRes = await dfs(startColors, dfsRegion, [])
        if(dfsRes) return { paths: [dfsRes], minSteps: dfsRes.length, timedOut }
      }
      // 否则：贪心近似路径（用于无限上限的情形，以保证有结果）
      const greedy = await (async function(){
        const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
        const neighbors = triangles.map(t=>t.neighbors)
        let colors = startColors.slice()
        const steps=[]
        let safeGuard=0
        const limit = Number.isFinite(stepLimit) ? stepLimit : 80
        while(!isUniform(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]}))) && safeGuard<limit){
          const regionSet = new Set()
          const q=[startId]; const visited=new Set([startId])
          const regionColor = colors[idToIndex.get(startId)]
          while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==regionColor) continue; regionSet.add(id); for(const nb of neighbors[idx]){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } } }
          const gain=new Map()
          for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri = triangles[nidx]; const c = colors[nidx]; if(c!==regionColor && c && c!=='transparent' && !tri.deleted){ gain.set(c, (gain.get(c)||0)+1) } } }
          const nextColor = [...gain.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] || (palette.find(c=>c!==regionColor) ?? palette[0])
          if(!nextColor || nextColor===regionColor) break
          for(const id of regionSet){ colors[idToIndex.get(id)] = nextColor }
          steps.push(nextColor); safeGuard++
          await new Promise(r=>setTimeout(r,0))
        }
        return steps
      })()
      return { paths: greedy.length? [greedy] : [], minSteps: greedy.length, timedOut }
  }
  const minSteps = solutions[0].length
  const paths = solutions.filter(s=>s.length===minSteps).slice(0, maxBranches)
  if (LOG_PERF) {
    try {
      console.log('[Solver] Perf', { nodes, enqueued: perf.enqueued, expanded: perf.expanded, filteredZero: perf.filteredZero, elapsedMs: Date.now() - startTime })
    } catch {}
  }
  return { paths, minSteps, timedOut }
}

  // 严格 A* 最短路（可选开关 strictMode）：可采纳下界 + 转置表剪枝（主线程回退）
  window.StrictAStarMinSteps = async function(triangles, startId, palette, onProgress, stepLimit=Infinity){
    const startTime = Date.now()
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    const TIME_BUDGET_MS = Math.min(Number.isFinite(FLAGS?.workerTimeBudgetMs) ? Math.max(1000, FLAGS.workerTimeBudgetMs) : (4000 + triangles.length * 10), 300000)
    const REPORT_INTERVAL_MS = Number.isFinite(FLAGS?.progressAStarIntervalMs) ? Math.max(0, FLAGS.progressAStarIntervalMs) : 80
    const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
    const neighbors = triangles.map(t=>t.neighbors)
    const startColors = triangles.map(t=>t.color)
    const globalTT = new Map()
    let timedOut = false

    // 位集支持：针对区域的热点操作提供 Set/Bitset 双实现
    const USE_BITSET = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? (window.SOLVER_FLAGS.useBitsetRegion !== false) : true
    const regionSize = (region)=> (region instanceof Set) ? region.size : bitsetCount(region)
    const regionIds = (region)=> (region instanceof Set) ? Array.from(region) : bitsetToIds(region, triangles)
    const buildRegionSet = (colors) => {
      const rc = colors[idToIndex.get(startId)]
      const rs = new Set(); const q=[startId]; const v=new Set([startId])
      while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
      return rs
    }
    const buildRegionBitset = (colors) => {
      const rc = colors[idToIndex.get(startId)]
      const bs = bitsetAlloc(triangles.length)
      const v = bitsetAlloc(triangles.length)
      const q=[startId]
      const sIdx = idToIndex.get(startId); if(sIdx!=null){ bitsetSet(v, sIdx) }
      while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; bitsetSet(bs, idx); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(nidx==null) continue; if(!bitsetHas(v, nidx)){ bitsetSet(v, nidx); q.push(nb) } } }
      return bs
    }
    const buildRegion = (colors)=> USE_BITSET ? buildRegionBitset(colors) : buildRegionSet(colors)
    const collectBoundaryNeighbors = (colors, region) => {
      const rc = colors[idToIndex.get(startId)]
      const boundary = new Set()
      const ids = regionIds(region)
      for(const tid of ids){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(nidx==null) continue; const tri=triangles[nidx]; const cc=colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ boundary.add(nb) } } }
      return Array.from(boundary)
    }
    const lowerBoundStrict = (colors, region) => {
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
      for(const tid of regionIds(region)){
        const idx=idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]
          if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ frontier.add(cc) }
        }
      }
      const lbFrontier = frontier.size
      // 桥接下界（结构化项）：使用边界不同颜色计数的保守近似
      const lbBridge = lbFrontier
      // 面积增量下界：remaining / 单步最大可扩展数量（使用全局同色最大计数作为安全上界）
      const remaining = Math.max(0, activeCount - regionSize(region))
      let maxColorCount = 0
      for(const v of colorFreq.values()){ if(v>maxColorCount) maxColorCount=v }
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
    const hashState = (colors, region)=>{
      let h = 0n
      for(let i=0;i<triangles.length;i++){
        const t=triangles[i]; const c=colors[i]
        if(!t.deleted && c && c!=='transparent'){
          const zv = zColor[i].get(c); if(zv!=null) h ^= zv
        }
      }
      const ids = regionIds(region)
      for(const tid of ids){ const idx=idToIndex.get(tid); h ^= (zRegion[idx]||0n) }
      return h.toString()
    }

    const startRegion = buildRegion(startColors)
    const seenBestG = new Map([[hashState(startColors, startRegion), 0]])
    const h0 = lowerBoundStrict(startColors, startRegion)
    let open = [{ colors:startColors, region:startRegion, steps:[], g:0, f:h0, boundaryNeighbors: collectBoundaryNeighbors(startColors, startRegion) }]
    let nodes = 0
    let maxDepth = 0
    let lastReport = startTime
    while(open.length){
      const nowTs = Date.now()
      if (nowTs - startTime > TIME_BUDGET_MS) { timedOut = true; break }
      if (REPORT_INTERVAL_MS<=0 || (nowTs - lastReport) >= REPORT_INTERVAL_MS){
        lastReport = nowTs
        try { onProgress?.({ phase:'strict_astar', nodes, open: open.length, depth: maxDepth, elapsedMs: nowTs - startTime }) } catch {}
        await new Promise(r=>setTimeout(r,0))
      }
      open.sort((a,b)=> (a.f ?? Infinity) - (b.f ?? Infinity))
      const cur = open.shift(); if(!cur) break
      nodes++
      maxDepth = Math.max(maxDepth, cur.steps.length)
      if(isUniform(cur.colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))){
        try { onProgress?.({ phase:'solution', minSteps: cur.steps.length, solutions: 1, elapsedMs: Date.now() - startTime }) } catch {}
        try { onProgress?.({ phase:'optimality_proof', reason:'A* with admissible strict lower bound ensures optimality', bound: lowerBoundStrict(cur.colors, cur.region), depth: cur.steps.length }) } catch {}
        return { paths: [cur.steps], minSteps: cur.steps.length, timedOut }
      }
      if (cur.steps.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) { continue }
      const rc = cur.colors[idToIndex.get(startId)]
      const adjColors = new Set(); const gain = new Map()
      const boundaryList = Array.isArray(cur.boundaryNeighbors) ? cur.boundaryNeighbors : collectBoundaryNeighbors(cur.colors, cur.region)
      for(const nb of boundaryList){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=cur.colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ adjColors.add(cc); gain.set(cc,(gain.get(cc)||0)+1) } }
      const tryColors = adjColors.size>0 ? [...adjColors] : palette
      for(const color of tryColors){ if(color===rc) continue
        // 颜色赋值复制
        const nextColors = cur.colors.slice();
        for(const id of regionIds(cur.region)){ nextColors[idToIndex.get(id)] = color }
        // 区域扩张（Set/Bitset 双实现）
        let newRegion
        if (USE_BITSET && !(cur.region instanceof Set)){
          const bs = bitsetAlloc(triangles.length)
          // seed: 当前区域
          for(const id of regionIds(cur.region)){ const ii=idToIndex.get(id); if(ii!=null) bitsetSet(bs, ii) }
          // 访问标记
          const visited2 = bitsetAlloc(triangles.length)
          for(const id of regionIds(cur.region)){ const ii=idToIndex.get(id); if(ii!=null) bitsetSet(visited2, ii) }
          const q = [...regionIds(cur.region)]
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!bitsetHas(visited2,nidx) && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ bitsetSet(visited2,nidx); bitsetSet(bs,nidx); q.push(nb) } } }
          newRegion = bs
        } else {
          const q=[...regionIds(cur.region)]; const setNew=new Set(regionIds(cur.region))
          const visited2 = new Uint8Array(triangles.length); for(const id of setNew){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2[nidx]=1; setNew.add(nb); q.push(nb) } } }
          newRegion = setNew
        }
        const key = hashState(nextColors, newRegion)
        const g = cur.steps.length + 1
        const prevG = seenBestG.get(key); if(prevG!=null && prevG <= g) continue
        const HEUR_NAME = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS.heuristicName : null
        const HEUR = HEUR_NAME ? getHeuristic(HEUR_NAME) : null
        const lbStrict = lowerBoundStrict(nextColors, newRegion)
        const h = HEUR ? (HEUR.isLayered ? HEUR({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion, lbStrict) : Math.max(lbStrict, HEUR({ triangles, idToIndex, neighbors, startId }, nextColors, newRegion))) : lbStrict
        if (Number.isFinite(stepLimit) && (g + h) > stepLimit) { continue }
        const f = g + h
        // TT 复用：保留最小 g / f，以剪枝重复状态（按颜色指派键）
        {
          const prev = globalTT.get(key)
          if (prev) {
            if (prev.gMin <= g) { continue }
            if ((prev.fMin ?? Infinity) <= f) { continue }
          }
          const gMin = Math.min(prev?.gMin ?? Infinity, g)
          const fMin = Math.min(prev?.fMin ?? Infinity, f)
          globalTT.set(key, { gMin, fMin })
        }
        seenBestG.set(key, g)
        // 增量构建下一状态的边界邻居缓存
        let nextBoundaryNeighbors
        {
          const boundarySet = new Set()
          for(const tid2 of regionIds(newRegion)){ const idx2=idToIndex.get(tid2); for(const nb2 of neighbors[idx2]){ const nidx2=idToIndex.get(nb2); if(nidx2==null) continue; const tri2=triangles[nidx2]; const c2=nextColors[nidx2]; if(c2!==color && c2 && c2!=='transparent' && !tri2.deleted){ boundarySet.add(nb2) } } }
          nextBoundaryNeighbors = Array.from(boundarySet)
        }
        open.push({ colors: nextColors, region: newRegion, steps: [...cur.steps, color], g, f, boundaryNeighbors: nextBoundaryNeighbors })
      }
    }
    return { paths: [], minSteps: 0, timedOut }
  }

  // IDA*（迭代加深 A*）：严格模式的可证最优解搜索，使用强下界与 Zobrist TT 去重
  window.StrictIDAStarMinSteps = async function(triangles, startId, palette, onProgress, stepLimit=Infinity){
    const startTime = Date.now()
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    const TIME_BUDGET_MS = Math.min(18000, 4000 + triangles.length * 10)
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
    const USE_BITSET = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? (window.SOLVER_FLAGS.useBitsetRegion !== false) : true
    const regionSize = (region)=> (region instanceof Set) ? region.size : bitsetCount(region)
    const regionIds = (region)=> (region instanceof Set) ? Array.from(region) : bitsetToIds(region, triangles)
    const buildRegionSet = (colors)=>{
      const rc = colors[idToIndex.get(startId)]
      const rs = new Set(); const q=[startId]; const v=new Set([startId])
      while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
      return rs
    }
    const buildRegionBitset = (colors)=>{
      const rc = colors[idToIndex.get(startId)]
      const bs = bitsetAlloc(triangles.length)
      const v = bitsetAlloc(triangles.length)
      const q=[startId]
      const sIdx=idToIndex.get(startId); if(sIdx!=null) bitsetSet(v,sIdx)
      while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==rc) continue; bitsetSet(bs, idx); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(nidx==null) continue; if(!bitsetHas(v,nidx)){ bitsetSet(v,nidx); q.push(nb) } } }
      return bs
    }
    const buildRegion = (colors)=> USE_BITSET ? buildRegionBitset(colors) : buildRegionSet(colors)
    const lowerBoundStrict = (colors, region) => {
      let activeCount = 0
      const colorFreq = new Map()
      for(let i=0;i<triangles.length;i++){
        const t=triangles[i]; const c=colors[i]
        if(!t.deleted && c && c!=='transparent'){ activeCount++; colorFreq.set(c, (colorFreq.get(c)||0)+1) }
      }
      const lbColors = Math.max(0, colorFreq.size - 1)
      const rc = colors[idToIndex.get(startId)]
      const frontier = new Set()
      for(const tid of regionIds(region)){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ frontier.add(cc) } } }
      const lbFrontier = frontier.size
      // 桥接下界（结构化项）：使用边界不同颜色计数的保守近似
      const lbBridge = lbFrontier
      const remaining = Math.max(0, activeCount - regionSize(region))
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
    const hashState = (colors, region)=>{
      let h = 0n
      for(let i=0;i<triangles.length;i++){
        const t=triangles[i]; const c=colors[i]
        if(!t.deleted && c && c!=='transparent'){
          const zv = zColor[i].get(c); if(zv!=null) h ^= zv
        }
      }
      for(const tid of regionIds(region)){ const idx=idToIndex.get(tid); h ^= (zRegion[idx]||0n) }
      return h.toString()
    }

    // 颜色集中度偏置（按初始图的同色连通分量数），搜索中保持不变
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

    // 全局 TT：跨迭代复用 min(g) 与 min(f)
    const globalTT = new Map()
    const perf = { expanded: 0, prunedBound: 0, prunedTTG: 0, prunedTTF: 0, prunedStepLimit: 0 }

    const startRegion = buildRegion(startColors)
    const h0 = lowerBoundStrict(startColors, startRegion)
    if (Number.isFinite(stepLimit) && h0 > stepLimit) { return { paths: [], minSteps: 0, timedOut } }
    let bound = h0
    let nodes = 0
    let maxDepth = 0
    let lastReport = startTime

    async function dfs(colors, regionSet, g, boundCur, path, tt, boundaryNeighbors){
      const nowTs = Date.now()
      if (nowTs - startTime > TIME_BUDGET_MS) { timedOut = true; return { found:false, nextBound: Infinity, path: null } }
      if (REPORT_INTERVAL_MS<=0 || (nowTs - lastReport) >= REPORT_INTERVAL_MS){
        lastReport = nowTs
        try { onProgress?.({ phase:'strict_idastar', nodes, depth: maxDepth, bound: boundCur, elapsedMs: nowTs - startTime, perf }) } catch {}
        await new Promise(r=>setTimeout(r,0))
      }
      if(isUniform(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))){
        try { onProgress?.({ phase:'solution', minSteps: path.length, solutions: 1, elapsedMs: Date.now() - startTime }) } catch {}
        try { onProgress?.({ phase:'optimality_proof', reason:'IDA* with admissible strict lower bound: first hit at bound is optimal', bound: boundCur, depth: path.length }) } catch {}
        return { found:true, nextBound: boundCur, path }
      }
      if (path.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) {
        perf.prunedStepLimit++
        return { found:false, nextBound: Infinity, path: null }
      }
      const HEUR_NAME = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS.heuristicName : null
      const HEUR = HEUR_NAME ? getHeuristic(HEUR_NAME) : null
      const lbStrictCur = lowerBoundStrict(colors, regionSet)
      const hVal = HEUR ? (HEUR.isLayered ? HEUR({ triangles, idToIndex, neighbors, startId }, colors, regionSet, lbStrictCur) : Math.max(lbStrictCur, HEUR({ triangles, idToIndex, neighbors, startId }, colors, regionSet))) : lbStrictCur
      const f = g + hVal
      if (f > boundCur) { perf.prunedBound++; return { found:false, nextBound: f, path: null } }
      // continue after bound check
      const key = hashState(colors, regionSet)
      const prevG = tt.get(key)
      if (prevG!=null && prevG <= g) { perf.prunedTTG++; return { found:false, nextBound: Infinity, path: null } }
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
        const bset = new Set()
        for(const tid of regionIds(regionSet)){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(nidx==null) continue; if(colors[nidx]!==rc){ bset.add(nb) } } }
        return Array.from(bset)
      })()
      for(const nb of boundaryList){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]; if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ adjColors.add(cc); gain.set(cc,(gain.get(cc)||0)+1) } }
      const tryColorsRaw = adjColors.size>0 ? [...adjColors] : palette
      const boundaryBefore = adjColors.size
      const basePreK = 6
      const prelim = tryColorsRaw.map(c=>{
        const g0=(gain.get(c)||0)
        const score0=g0*3 + getBiasStrict(c)
        return { c, score0, gain:g0 }
      }).sort((a,b)=> b.score0 - a.score0).slice(0, basePreK)
      const regionBoundaryNeighbors=[]
      for(const tid of regionSet){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(nidx==null) continue; if(colors[nidx]!==rc){ regionBoundaryNeighbors.push(nb) } } }
      const enlargePotential = new Map(); const saddlePotential = new Map()
      for(const {c} of prelim){
        const seeds=[]; for(const nb of regionBoundaryNeighbors){ const nbIdx=idToIndex.get(nb); if(nbIdx!=null && colors[nbIdx]===c){ seeds.push(nb) } }
        const seedSet=new Set(seeds)
        const visitedB=new Set(); let compCountB=0
        for(const s of seeds){ if(visitedB.has(s)) continue; compCountB++; const qB=[s]; visitedB.add(s); while(qB.length){ const u=qB.shift(); const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx!=null && seedSet.has(v) && !visitedB.has(v) && colors[vIdx]===c){ visitedB.add(v); qB.push(v) } } } }
        const boundarySeedCount=seeds.length
        enlargePotential.set(c, boundarySeedCount*1.0 + Math.max(0, boundarySeedCount - compCountB)*0.5)
        const visitedS=new Set(); const compSizes=[]
        for(const s of seeds){ if(visitedS.has(s)) continue; let size=0; const q=[s]; visitedS.add(s); while(q.length){ const u=q.shift(); size++; const uIdx=idToIndex.get(u); for(const v of neighbors[uIdx]){ const vIdx=idToIndex.get(v); if(vIdx==null) continue; if(!visitedS.has(v) && colors[vIdx]===c){ visitedS.add(v); q.push(v) } } } }
        compSizes.sort((a,b)=>b-a)
        saddlePotential.set(c, compSizes.length)
      }
      const tryColors = tryColorsRaw
        .map(c=>{
          const g0=(gain.get(c)||0)
          const pot=(enlargePotential.get(c)||0)
          const saddle=(saddlePotential.get(c)||0)
          let score = g0*3 + pot*2 + saddle*BF_W + getBiasStrict(c)
          if (ENABLE_BRIDGE_FIRST){ const adjAfter = computeAdjAfterSize(c, colors, regionSet); score += (boundaryBefore - adjAfter) * BOUNDARY_WEIGHT; score += adjAfter * ADJ_AFTER_WEIGHT }
          return { c, score }
        })
        .sort((a,b)=> b.score - a.score)
        .map(x=>x.c)
      let minNextBound = Infinity
      for(const color of tryColors){ if(color===rc) continue
        const nextColors = colors.slice();
        for(const id of regionIds(regionSet)){ nextColors[idToIndex.get(id)] = color }
        // 区域扩张
        let newRegion
        if (USE_BITSET && !(regionSet instanceof Set)){
          const bs = bitsetAlloc(triangles.length)
          // seed
          for(const id of regionIds(regionSet)){ const ii=idToIndex.get(id); if(ii!=null) bitsetSet(bs, ii) }
          const visited2 = bitsetAlloc(triangles.length)
          for(const id of regionIds(regionSet)){ const ii=idToIndex.get(id); if(ii!=null) bitsetSet(visited2, ii) }
          const q=[...regionIds(regionSet)]
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!bitsetHas(visited2,nidx) && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ bitsetSet(visited2,nidx); bitsetSet(bs,nidx); q.push(nb) } } }
          newRegion = bs
        } else {
          const q=[...regionIds(regionSet)]; const setNew=new Set(regionIds(regionSet))
          const visited2 = new Uint8Array(triangles.length); for(const id of setNew){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
          while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2[nidx]=1; setNew.add(nb); q.push(nb) } } }
          newRegion = setNew
        }
        const gNext = g + 1
        const HEUR_NAME2 = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS.heuristicName : null
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
          for(const tid2 of regionIds(newRegion)){ const idx2=idToIndex.get(tid2); for(const nb2 of neighbors[idx2]){ const nidx2=idToIndex.get(nb2); if(nidx2==null) continue; const tri2=triangles[nidx2]; const c2=nextColors[nidx2]; if(c2!==color && c2 && c2!=='transparent' && !tri2.deleted){ boundarySet.add(nb2) } } }
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

  // 自动选择最佳起点：遍历同色连通分量，取最短路径的起点
  window.Solver_minStepsAuto = async function(triangles, palette, maxBranches=3, onProgress, stepLimit=Infinity){
    const startTime = Date.now()
    const TIME_BUDGET_MS = Math.min(18000, 4000 + triangles.length * 10)
    let timedOut = false
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    // 并行模式：若开启则交由并行求解器
    if (FLAGS.enableMultiWorker) {
      try {
        return await window.Solver_minStepsAutoParallel?.(triangles, palette, maxBranches, onProgress, stepLimit)
      } catch (e) {
        // 并行失败则回退到单线程
        console.warn('[Solver] Parallel auto failed, fallback to single-thread', e)
      }
    }
    // 若启用分块/宏规划，则执行粗到细计划并回退到严格求解器
    if (FLAGS.enableBlockingPlanner){
      try {
        const blocks = partitionBlocks(triangles, { maxBlockSize: Math.max(32, Math.floor(triangles.length/20)) })
        const macro = planBlockAStar(triangles, blocks, triangles.find(t=>!t.deleted)?.id || 0, palette, (p)=>{ try { onProgress?.({ phase:'blocking', ...p }) } catch {} })
        const path = await (await import('./blocking')).executeBlockPlan(triangles, macro.blocks, macro.order, palette, (p)=>{ try { onProgress?.({ phase:'blocking_exec', ...p }) } catch {} })
        const resOpt = await window.OptimizeSolution?.(triangles, palette, macro.order?.[0] ?? (triangles.find(t=>!t.deleted)?.id || 0), path, (p)=>{ try { onProgress?.({ phase:'optimize', ...p }) } catch {} })
        return { bestStartId: macro.order?.[0] ?? null, paths: [resOpt?.optimizedPath || path], minSteps: (resOpt?.optimizedPath || path).length, timedOut: false }
      } catch (e) {
        console.warn('[BlockingPlanner] Failed, fallback to normal auto solve', e)
      }
    }
    const USE_DFS_FIRST = !!FLAGS.useDFSFirst
    const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
    const neighbors = triangles.map(t=>t.neighbors)
    const visited = new Set()
    const components = []
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
        for(const nb of neighbors[idx]){
          if(!visited.has(nb)){
            const nidx=idToIndex.get(nb)
            const tri2=triangles[nidx]
            if(!tri2.deleted && tri2.color!=='transparent' && tri2.color===color){
              visited.add(nb); q.push(nb)
            }
          }
        }
      }
      if(comp.length>0) {
        components.push({ color, ids: comp, startId: comp[0], size: comp.length })
        // 组件阶段进度节流（与 worker 保持一致）
        try {
          const PROG_COMP_INTERVAL = Number.isFinite(window.SOLVER_FLAGS?.progressComponentsIntervalMs)
            ? Math.max(0, window.SOLVER_FLAGS.progressComponentsIntervalMs)
            : 100
          window.__COMP_LAST_TS__ = window.__COMP_LAST_TS__ || Date.now()
          const nowTs = Date.now()
          if (!onProgress) {
            // noop
          } else if (PROG_COMP_INTERVAL <= 0 || (nowTs - window.__COMP_LAST_TS__) >= PROG_COMP_INTERVAL) {
            window.__COMP_LAST_TS__ = nowTs
            onProgress({ phase: 'components', count: components.length, elapsedMs: nowTs - startTime })
          } else {
            onProgress({ phase: 'components', count: components.length, elapsedMs: nowTs - startTime })
          }
        } catch {}
      }
  }
    // 预处理阶段结束：输出一次总结打点，便于判定阶段完成（主线程实现，与 worker 保持一致）
    try {
      const nowTs = Date.now()
      const largest = components.length>0 ? components.reduce((m,c)=> Math.max(m, c.size||0), 0) : 0
      onProgress?.({ phase:'components_done', count: components.length, largest, elapsedMs: nowTs - startTime })
    } catch {}
    if(components.length===0) return { bestStartId: null, paths: [], minSteps: 0 }
    // 若指定了优先起点，则将该分量置顶；否则按大小排序
    try {
      const preferred = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS.preferredStartId : null
      if (preferred!=null) {
        const idxPref = components.findIndex(c=>c.startId===preferred)
        if (idxPref>0) { const [c] = components.splice(idxPref,1); components.unshift(c) }
      }
    } catch {}
    components.sort((a,b)=>b.size-a.size)
    let best={ startId:null, minSteps: Infinity, paths: [] }
    for(const comp of components){
      if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break }
      // 让出事件循环，保证 UI 可渲染
      await new Promise(r=>setTimeout(r,0))
      // SAT 宏规划：基于边界的集合覆盖，先行滚动颜色序列；若成功覆盖则直接优化返回
      if (!!FLAGS.enableSATPlanner) {
        try {
          const plan = await satMacroColorPlan(triangles, comp.startId, palette)
          const order = Array.isArray(plan?.order) ? plan.order : []
          if (order.length>0){
            // 预演颜色序列的滚动执行
            const colorsCur = triangles.map(t=>t.color)
            const idToIndexLocal = idToIndex
            const neighborsLocal = neighbors
            const applyColor = (colorsLocal, regionSetLocal, color)=>{
              const tmp = colorsLocal.slice(); const rc=color
              for(const id of regionSetLocal){ tmp[idToIndexLocal.get(id)] = rc }
              const newRegion = new Set([...regionSetLocal])
              const q=[...regionSetLocal]; const v=new Set([...regionSetLocal])
              while(q.length){ const tid=q.shift(); const idx=idToIndexLocal.get(tid); for(const nb of neighborsLocal[idx]){ const nidx=idToIndexLocal.get(nb); const tri=triangles[nidx]; if(!v.has(nb) && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===rc){ v.add(nb); newRegion.add(nb); q.push(nb) } } }
              return { nextColors: tmp, nextRegion: newRegion }
            }
            const buildRegion = (colorsLocal)=>{
              const rc = colorsLocal[idToIndexLocal.get(comp.startId)]
              const rs = new Set(); const q=[comp.startId]; const v=new Set([comp.startId])
              while(q.length){ const id=q.shift(); const idx=idToIndexLocal.get(id); if(colorsLocal[idx]!==rc) continue; rs.add(id); for(const nb of neighborsLocal[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } }
              return rs
            }
            let regionSet = buildRegion(colorsCur)
            const path = []
            for(const col of order){ const { nextColors, nextRegion } = applyColor(colorsCur, regionSet, col); colorsCur.splice(0, colorsCur.length, ...nextColors); regionSet = nextRegion; path.push(col) }
            const uniform = isUniform(colorsCur.map((c,i)=>({ color:c, id: i, neighbors: neighborsLocal[i] })))
            if (uniform){
              const opt = await window.OptimizeSolution?.(triangles, palette, comp.startId, path, (p)=>{ try { onProgress?.({ phase:'optimize', startId: comp.startId, ...p }) } catch {} })
              const p2 = opt?.optimizedPath || path
              const steps = p2.length
              if(steps < best.minSteps){ best = { startId: comp.startId, minSteps: steps, paths: [p2] } }
              // 若已不超过 stepLimit 则直接结束
              if (Number.isFinite(stepLimit) && steps <= stepLimit) { break }
              continue
            }
          }
        } catch (e){ console.warn('[SAT macro planner] failed', e) }
      }
      // 严格模式：若开启则优先用 A* 求最短路（主线程回退）
      if (!!FLAGS.strictMode) {
        const useIDA = !!FLAGS.useIDAStar
        const resStrict = useIDA
          ? await window.StrictIDAStarMinSteps?.(triangles, comp.startId, palette, (p)=>{ if (onProgress) { try { onProgress({ phase:'subsearch', startId: comp.startId, ...p }) } catch {} } }, stepLimit)
          : await window.StrictAStarMinSteps?.(triangles, comp.startId, palette, (p)=>{ if (onProgress) { try { onProgress({ phase:'subsearch', startId: comp.startId, ...p }) } catch {} } }, stepLimit)
        if(resStrict && resStrict.paths && resStrict.paths.length>0){
          if(resStrict.minSteps < best.minSteps){
            best = { startId: comp.startId, minSteps: resStrict.minSteps, paths: resStrict.paths }
            if (onProgress) { try { onProgress({ phase:'best_update', bestStartId: best.startId, minSteps: best.minSteps }) } catch {} }
          }
          if (Number.isFinite(stepLimit) && resStrict.minSteps <= stepLimit) { break }
          if (resStrict.timedOut) timedOut = true
        } else if (FLAGS.enableMCTSFallback) {
          // 退避到 MCTS，时间预算可配；随后进行路径后处理压缩
          const budget = Number.isFinite(FLAGS?.mctsTimeBudgetMs) ? Math.max(200, FLAGS.mctsTimeBudgetMs) : 1200
          try {
            const mres = await mctsSolve(triangles, comp.startId, palette, budget, (p)=>{ try { onProgress?.({ phase:'mcts', startId: comp.startId, ...p }) } catch {} })
            if (Array.isArray(mres?.path) && mres.path.length>0){
              const opt = await window.OptimizeSolution?.(triangles, palette, comp.startId, mres.path, (p)=>{ try { onProgress?.({ phase:'optimize', startId: comp.startId, ...p }) } catch {} })
              const path = opt?.optimizedPath || mres.path
              const steps = path.length
              if(steps < best.minSteps){ best = { startId: comp.startId, minSteps: steps, paths: [path] } }
            }
          } catch (e){ console.warn('[MCTS fallback] failed', e) }
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
            const colorCount=new Map(); for(const t of triangles){ if(!t.deleted && t.color && t.color!=='transparent'){ colorCount.set(t.color,(colorCount.get(t.color)||0)+1) } }
            const raw = adjColors.size>0 ? [...adjColors] : palette
            const LEARN = (typeof window !== 'undefined' && window.SOLVER_FLAGS && window.SOLVER_FLAGS.enableLearningPrioritizer) ? (window.__UCB_PRIOR__ || (window.__UCB_PRIOR__ = new UCBColorPrioritizer(palette))) : null
            const score=(c)=>{ let s=(gain.get(c)||0)*3 + (colorCount.get(c)||0)*0.5; if(LEARN){ s += LEARN.ucb(c) * 1.0 } return s }
            return raw.sort((a,b)=>score(b)-score(a)).slice(0,8).filter(c=>c!==rc)
          }
          const startTs = Date.now()
          async function dfs(colors, regionSet, steps){
            if(isUniform(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))) return steps
            if(steps.length>=stepLimit) return null
            if(Date.now()-startTs > TIME_BUDGET_MS) return null
            const tryColors = orderColors(colors, regionSet)
            for(const color of tryColors){
              const nextColors = colors.slice(); for(const id of regionSet) nextColors[idToIndex.get(id)] = color
              const key = keyFromColors(nextColors); if(seen.has(key)) continue; seen.add(key)
              const q=[...regionSet]; const visited2=new Set([...regionSet]); const newRegion=new Set([...regionSet])
              while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2.has(nb) && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2.add(nb); newRegion.add(nb); q.push(nb) } }
              }
              try {
                const LEARN = (typeof window !== 'undefined' && window.__UCB_PRIOR__) ? window.__UCB_PRIOR__ : null
                if (LEARN) {
                  const delta = (newRegion.size - regionSet.size) / Math.max(1, regionSet.size)
                  LEARN.record(color, Math.max(0, delta))
                }
              } catch {}
              const res = await dfs(nextColors, newRegion, [...steps,color]); if(res) return res
              await new Promise(r=>setTimeout(r,0))
            }
            return null
          }
          const dfsRegion = buildRegion(startColors)
          const dfsRes = await dfs(startColors, dfsRegion, [])
          if(dfsRes){ if (onProgress) { try { onProgress({ phase:'solution', minSteps: dfsRes.length, solutions: 1, elapsedMs: Date.now() - startTime }) } catch {} } ; return { paths:[dfsRes], minSteps: dfsRes.length, timedOut } }
          return null
        })()
        if (resDFS && resDFS.paths && resDFS.paths.length>0) {
          return { bestStartId: comp.startId, paths: resDFS.paths, minSteps: resDFS.minSteps, timedOut }
        }
      }
      const res = await window.Solver_minSteps?.(triangles, comp.startId, palette, maxBranches, (p)=>{
        if (onProgress) {
          try { onProgress({ phase: 'subsearch', startId: comp.startId, ...p }) } catch {}
        }
      }, stepLimit)
      if(res && res.paths && res.paths.length>0){
        if(res.minSteps < best.minSteps){
          best = { startId: comp.startId, minSteps: res.minSteps, paths: res.paths }
          if (onProgress) {
            try { onProgress({ phase: 'best_update', bestStartId: best.startId, minSteps: best.minSteps }) } catch {}
          }
        }
        // 若已达到步数上限的最优解，提前结束以节省时间
        if (Number.isFinite(stepLimit) && res.minSteps <= stepLimit) {
          break
        }
        // 若子求解器超时，记录但继续尝试其它分量（以便可能找到更快的）
        if (res.timedOut) timedOut = true
      }
    }
    if(best.minSteps===Infinity) return { bestStartId: null, paths: [], minSteps: 0, timedOut }
    return { bestStartId: best.startId, paths: best.paths, minSteps: best.minSteps, timedOut }
  }

  // 多 Worker 并行自动求解：为若干候选起点分别启动 worker 并行搜索，取最优
  window.Solver_minStepsAutoParallel = async function(triangles, palette, maxBranches=3, onProgress, stepLimit=Infinity){
    const startTime = Date.now()
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    const PARALLEL_WORKERS = Number.isFinite(FLAGS?.parallelWorkers) ? Math.max(1, FLAGS.parallelWorkers) : 3
    const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
    const neighbors = triangles.map(t=>t.neighbors)
    // 枚举同色连通分量，选取前 K 大作为候选起点
    const components = []
    const visited = new Set()
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
        for(const nb of neighbors[idx]){
          if(!visited.has(nb)){
            const nidx=idToIndex.get(nb)
            const tri2=triangles[nidx]
            if(!tri2.deleted && tri2.color!=='transparent' && tri2.color===color){ visited.add(nb); q.push(nb) }
          }
        }
      }
      if(comp.length>0){ components.push({ color, ids: comp, startId: comp[0], size: comp.length }) }
    }
    components.sort((a,b)=> b.size - a.size)
    const picks = components.slice(0, PARALLEL_WORKERS)
    if (picks.length===0) return { bestStartId: null, paths: [], minSteps: 0, timedOut: false }
    const workers = []
    const promises = []
    let best = { startId: null, minSteps: Infinity, paths: [], timedOut: false }
    const updateBest = (res, sid)=>{
      if(res && Array.isArray(res.paths) && res.paths.length>0){
        if(res.minSteps < best.minSteps){ best = { startId: sid, minSteps: res.minSteps, paths: res.paths, timedOut: !!res.timedOut } }
        onProgress?.({ phase:'best_update', bestStartId: best.startId, minSteps: best.minSteps })
      }
    }
    for(let i=0;i<picks.length;i++){
      const pick = picks[i]
      const worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type:'module' })
      workers.push(worker)
      // 传入全局 flags（包含 preferredStartId），保证与主线程配置一致
      worker.postMessage({ type:'set_flags', flags: { ...(FLAGS||{}), preferredStartId: pick.startId } })
      const p = new Promise((resolve)=>{
        let configured = false
        worker.onmessage = (e)=>{
          const { type, payload } = e.data || {}
          if(type==='flags_set'){
            configured = true
            const ragOptions = { enable: !!FLAGS.enableRAGMacro }
            worker.postMessage({ type:'auto', triangles, palette, maxBranches, stepLimit, ragOptions })
          }
          else if(type==='progress'){ onProgress?.({ phase:'parallel_progress', workerIndex: i, startId: pick.startId, ...payload }) }
          else if(type==='result'){
            updateBest(payload, pick.startId)
            resolve(payload)
          }
        }
        worker.onerror = (err)=>{ console.warn('[Solver] Worker error', err); resolve({ paths: [], minSteps: Infinity, timedOut: true }) }
      })
      promises.push(p)
    }
    const results = await Promise.all(promises)
    // 结束所有 worker
    for(const w of workers){ try { w.terminate() } catch {} }
    const anyTimedOut = results.some(r=>r?.timedOut)
    if (best.minSteps===Infinity) return { bestStartId: null, paths: [], minSteps: 0, timedOut: anyTimedOut }
    return { bestStartId: best.startId, paths: best.paths, minSteps: best.minSteps, timedOut: anyTimedOut }
  }

  // 方案后处理优化：对已统一颜色路径进行反思、拆解与压缩（主线程回退）
  window.OptimizeSolution = async function(triangles, palette, startId, path, onProgress){
    const startTime = Date.now()
    const TIME_BUDGET_MS = Math.min(120000, 4000 + triangles.length * 10)
    const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
    const neighbors = triangles.map(t=>t.neighbors)
    const originalPath = Array.isArray(path) ? path.slice() : []
    // 早停：路径超过50，直接跳过优化，仅返回关键信息
    if (Array.isArray(path) && path.length > 50) {
      onProgress?.({ phase:'optimize_skipped', reason:'path_too_long', length: path.length })
      return { bestStartId: startId, optimizedPath: path, originalLen: path.length, optimizedLen: path.length, shortened: false, analysis: { ok:true, skipped:true, reason:'path_too_long' } }
    }
    // 进度节流，降低主线程压力
    const makeThrottled = (fn, interval)=>{ let last=0; return (p)=>{ const now=Date.now(); if(now-last>=interval){ last=now; try{ fn?.(p) }catch{} } } }
    const report = onProgress ? makeThrottled(onProgress, 100) : null
    // 快速统一性判定（基于颜色数组，提前退出）
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
    let colors = triangles.map(t=>t.color)
    let tmpColors = colors.slice()
    for(const stepColor of path){ const region = buildRegion(tmpColors, startId); for(const id of region){ tmpColors[idToIndex.get(id)] = stepColor } }
    const initiallyUniform = isUniformFast(tmpColors)
    if(!initiallyUniform){
      report?.({ phase:'analysis', ok:false, reason:'path_not_unified' })
    }
    const gains=[]
    let simColors = colors.slice()
    for(const color of path){
      const region = buildRegion(simColors, startId)
      const before = region.size
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
    report?.({ phase:'analysis', ok:true, len: path.length, criticalCount: critical.length, topGains: sorted.slice(0,5), mean, std })
    // 基于三类×三维对路径进行分段重排与压缩
    const idToIndex2 = idToIndex
    const neighbors2 = neighbors
    const classifyStep = (curColors, region, color)=>{
      const boundaryDistinctLocal = (colors0, region0)=>{
        const rc = colors0[idToIndex2.get(startId)]
        const set = new Set()
        for(const tid of region0){ const idx=idToIndex2.get(tid); for(const nb of neighbors2[idx]){ const nidx=idToIndex2.get(nb); const tri=triangles[nidx]; const c=colors0[nidx]; if(c!==rc && c && c!=='transparent' && !tri.deleted){ set.add(c) } } }
        return set.size
      }
      const adjAfter = (function(){
        const q=[...region]; const visited=new Set([...region]); const newRegion=new Set([...region])
        const tmp = curColors.slice(); for(const id of region) tmp[idToIndex2.get(id)] = color
        while(q.length){ const tid=q.shift(); const idx=idToIndex2.get(tid); for(const nb of neighbors2[idx]){ const nidx=idToIndex2.get(nb); const tri=triangles[nidx]; if(!visited.has(nb) && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===color){ visited.add(nb); newRegion.add(nb); q.push(nb) } } }
        return newRegion.size
      })()
      const bdBefore = boundaryDistinctLocal(curColors, region)
      const tmp2 = curColors.slice(); for(const id of region) tmp2[idToIndex2.get(id)] = color
      const bdAfter = boundaryDistinctLocal(tmp2, region)
      let connectScore = 0
      try {
        const rag = buildRAG(triangles)
        const newRegionSet = (function(){
          const q=[...region]; const v=new Set([...region]); const set=new Set([...region])
          const tmp = curColors.slice(); for(const id of region) tmp[idToIndex2.get(id)] = color
          while(q.length){ const tid=q.shift(); const idx=idToIndex2.get(tid); for(const nb of neighbors2[idx]){ const nidx=idToIndex2.get(nb); const tri=triangles[nidx]; if(!v.has(nb) && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===color){ v.add(nb); set.add(nb); q.push(nb) } } }
          return set
        })()
        const seenComps = new Set()
        for(const tid of newRegionSet){ const idx=idToIndex2.get(tid); for(const nb of neighbors2[idx]){ const nidx=idToIndex2.get(nb); const cj = rag.triToComp[nidx]; if(cj!=null){ seenComps.add(cj) } } }
        connectScore = seenComps.size
      } catch {}
      const barrierDelta = Math.max(0, bdBefore - bdAfter)
      if (connectScore >= Math.max(1, barrierDelta)) return 'bridge'
      if (barrierDelta > 0) return 'boundary'
      return 'richness'
    }
    let curColors2 = colors.slice()
    const tags = []
    for(const color of path){ const region = buildRegion(curColors2, startId); const tag = classifyStep(curColors2, region, color); tags.push(tag); for(const id of region){ curColors2[idToIndex2.get(id)] = color } }
    const bridgeSteps = []; const boundarySteps=[]; const richnessSteps=[]
    for(let i=0;i<path.length;i++){ const c=path[i]; const tag=tags[i]; if(tag==='bridge') bridgeSteps.push(c); else if(tag==='boundary') boundarySteps.push(c); else richnessSteps.push(c) }
    let candidate = [...bridgeSteps, ...boundarySteps, ...richnessSteps]
    const compressed = []
    for(const c of candidate){ if(compressed.length===0 || compressed[compressed.length-1]!==c) compressed.push(c) }
    candidate = compressed.filter((c, i)=> gains[i]>0 )
    let testColors = triangles.map(t=>t.color)
    for(const c of candidate){ const reg = buildRegion(testColors, startId); for(const id of reg){ testColors[idToIndex.get(id)] = c } }
    const candidateOk = isUniformFast(testColors)
    if(candidateOk && candidate.length <= path.length){ path = candidate }
    // 局部窗口重排（关注高权重与高连通潜力）
    const OPT_WINDOW_SIZE = Number.isFinite(window.SOLVER_FLAGS?.optimizeWindowSize) ? window.SOLVER_FLAGS.optimizeWindowSize : 5
    const OPT_ENABLE_WINDOW = window.SOLVER_FLAGS?.optimizeEnableWindow !== false
      if (initiallyUniform && OPT_ENABLE_WINDOW && OPT_WINDOW_SIZE>1){
        const reorderWithinWindow = (p)=>{
          let curColors = triangles.map(t=>t.color)
          const idIdx = idToIndex
          const neigh = neighbors
          const metrics=[]
          for(const color of p){
            const region = buildRegion(curColors, startId)
            const rc = curColors[idIdx.get(startId)]
            const adjSet=new Set(); for(const tid of region){ const idx=idIdx.get(tid); for(const nb of neigh[idx]){ const nidx=idIdx.get(nb); const cc=curColors[nidx]; if(cc!==rc && cc && cc!=='transparent'){ adjSet.add(cc) } } }
            const beforeAdj = adjSet.size
            const tmp=curColors.slice(); for(const id of region){ tmp[idIdx.get(id)] = color }
            const reg2=new Set([...region])
            const q=[...region]
            const visited = new Uint8Array(triangles.length)
            for(const id of region){ const idx=idIdx.get(id); if(idx!=null) visited[idx]=1 }
            while(q.length){ const tid=q.shift(); const idx=idIdx.get(tid); for(const nb of neigh[idx]){ const nidx=idIdx.get(nb); const tri=triangles[nidx]; if(!visited[nidx] && !tri.deleted && tri.color!=='transparent' && tmp[nidx]===color){ visited[nidx]=1; reg2.add(nb); q.push(nb) } } }
            const adjSet2=new Set(); for(const tid of reg2){ const idx=idIdx.get(tid); for(const nb of neigh[idx]){ const nidx=idIdx.get(nb); const cc=tmp[nidx]; if(cc!==color && cc && cc!=='transparent'){ adjSet2.add(cc) } } }
            const afterAdj = adjSet2.size
            const barrierDelta = Math.max(0, beforeAdj - afterAdj)
            const expandAdj = afterAdj
            // 计算窗口内“saddle”多前沿潜力（边界上颜色 color 的连通分量前两大之和）
            const seeds=[]; for(const tid of reg2){ const idx=idIdx.get(tid); for(const nb of neigh[idx]){ const nidx=idIdx.get(nb); if(tmp[nidx]===color && !reg2.has(nb)) seeds.push(nb) }
            }
            const visitedW = new Set(); const compSizesW=[]
            for(const s of seeds){ if(visitedW.has(s)) continue; let size=0; const q2=[s]; visitedW.add(s); while(q2.length){ const u=q2.shift(); size++; const uIdx=idIdx.get(u); for(const v of neigh[uIdx]){ const vIdx=idIdx.get(v); if(vIdx==null) continue; if(!visitedW.has(v) && tmp[vIdx]===color){ visitedW.add(v); q2.push(v) } } } compSizesW.push(size) }
            compSizesW.sort((a,b)=>b-a)
            const saddleScore = (compSizesW[0]||0) + (compSizesW[1]||0)
            const tag = barrierDelta>0 ? 'boundary' : (afterAdj>beforeAdj ? 'bridge' : 'richness')
            const RCW = (window.SOLVER_FLAGS?.regionClassWeights) || {}
            const DIW = (window.SOLVER_FLAGS?.dimensionWeights) || {}
            const priority = (RCW[tag] ?? 1) * ((DIW.expand ?? 1)*expandAdj + (DIW.barrier ?? 0.7)*barrierDelta) + (RCW.saddle ?? 1.2) * (DIW.multiFront ?? 2.0) * saddleScore
            metrics.push({ color, priority })
            for(const id of region){ curColors[idIdx.get(id)] = color }
          }
        const out=[]
        for(let i=0;i<p.length;i+=OPT_WINDOW_SIZE){
          const seg = metrics.slice(i, i+OPT_WINDOW_SIZE)
          const sortedSeg = seg.slice().sort((a,b)=> b.priority - a.priority)
          out.push(...sortedSeg.map(x=>x.color))
        }
        // 验证
        let testColors2 = triangles.map(t=>t.color)
        for(const c of out){ const reg = buildRegion(testColors2, startId); for(const id of reg){ testColors2[idToIndex.get(id)] = c } }
        return isUniformFast(testColors2) ? out : p
      }
      const newPath = reorderWithinWindow(path)
      if(newPath.length === path.length) path = newPath
    }
    // 反思压缩：尝试移除低优先步骤（仍能统一颜色）
    const OPT_ENABLE_REMOVAL = window.SOLVER_FLAGS?.optimizeEnableRemoval !== false
    if (initiallyUniform && OPT_ENABLE_REMOVAL){
      const SNAP_K = 3
      const buildSnapshots = (p)=>{ const snaps=[]; let cc=triangles.map(t=>t.color); for(let i=0;i<p.length;i++){ const reg=buildRegion(cc,startId); for(const id of reg){ cc[idToIndex.get(id)] = p[i] } if((i+1)%SNAP_K===0) snaps.push({ step:i+1, colors: cc.slice() }) } return { snaps } }
      let changed = true; let attempts=0
      const maxAttempts = Math.min(12, Math.ceil(path.length/6))
      while(changed && attempts<maxAttempts){
        changed=false; attempts++
        const { snaps } = buildSnapshots(path)
        for(let i=0;i<path.length;i++){
          const candidate2 = path.slice(0,i).concat(path.slice(i+1))
          // 下界预检：若当前增益不低于均值，跳过尝试
          const meanGain = gains.reduce((s,x)=>s+x,0)/(gains.length||1)
          if (i<gains.length && gains[i] >= meanGain) continue
          // 从最近快照重放
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
    const OPT_ENABLE_BOUND_TRIM = window.SOLVER_FLAGS?.optimizeEnableBoundTrim !== false
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
    const OPT_ENABLE_SWAP = window.SOLVER_FLAGS?.optimizeEnableSwap !== false
    let OPT_SWAP_PASSES = Number.isFinite(window.SOLVER_FLAGS?.optimizeSwapPasses) ? window.SOLVER_FLAGS.optimizeSwapPasses : 1
    if (path.length>80) OPT_SWAP_PASSES = Math.max(1, Math.min(OPT_SWAP_PASSES, 1))
    if (initiallyUniform && OPT_ENABLE_SWAP && path.length>1){
      const compressAdj = (arr)=>{ const out=[]; for(const c of arr){ if(out.length===0 || out[out.length-1]!==c) out.push(c) } return out }
      const lbLocal = (colorsLocal)=>{ const s=new Set(); for(let i=0;i<triangles.length;i++){ const t=triangles[i]; const c=colorsLocal[i]; if(!t.deleted && c && c!=='transparent') s.add(c) } return Math.max(0, s.size - 1) }
      const lbAfterFirst = (p)=>{ let cc = triangles.map(t=>t.color); const region = buildRegion(cc, startId); const next = cc.slice(); for(const id of region){ next[idToIndex.get(id)] = p[0] } return lbLocal(next) }
      for(let pass=0; pass<OPT_SWAP_PASSES; pass++){
        let improved=false
        for(let i=0;i<path.length-1;i++){
          const tryPath = path.slice(0,i).concat([path[i+1], path[i]], path.slice(i+2))
          // 验证统一性
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
    // 局部修复：在进一步搜索前进行一次安全压缩
    try {
      const rep = await localRepair(triangles, palette, startId, path, (p)=>{ report?.({ ...p }) })
      if (rep && Array.isArray(rep.path) && rep.path.length <= path.length) {
        path = rep.path
      }
    } catch {}
    // 尝试在上限为原路径-1条件下重新自动求解（DFS-first + 早停）
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    const prevUseDFS = FLAGS.useDFSFirst
    const prevReturn = FLAGS.returnFirstFeasible
    try { window.SOLVER_FLAGS = { ...FLAGS, useDFSFirst: true, returnFirstFeasible: true } } catch {}
    const targetLimit = Math.max(0, path.length-1)
    let res = await window.Solver_minStepsAuto?.(triangles, palette, 3, (p)=>{ report?.({ ...p, phase: p?.phase || 'optimize_search' }) }, targetLimit)
    // 若首轮未改善，尝试第二轮：调整权重偏向桥接与扩张
    if(!(res && res.paths && res.paths.length>0 && res.minSteps < path.length)){
      const FLAGS2 = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
      const prevUseDFS2 = FLAGS2.useDFSFirst
      const prevReturn2 = FLAGS2.returnFirstFeasible
      const prevAdj = FLAGS2.adjAfterWeight
      const prevBoundary = FLAGS2.boundaryWeight
      const prevBridge = FLAGS2.bridgeWeight
      try { window.SOLVER_FLAGS = { ...FLAGS2, useDFSFirst: true, returnFirstFeasible: true, adjAfterWeight: Math.max(0.4, (prevAdj??0.6)*1.2), boundaryWeight: Math.max(0.6, (prevBoundary??0.8)*1.1), bridgeWeight: Math.max(1.0, (prevBridge??1.0)*1.3) } } catch {}
      report?.({ phase:'optimize_search_round2' })
      res = await window.Solver_minStepsAuto?.(triangles, palette, 3, (p)=>{ report?.({ ...p, phase: p?.phase || 'optimize_search_round2' }) }, targetLimit)
      try { window.SOLVER_FLAGS = { ...window.SOLVER_FLAGS, useDFSFirst: prevUseDFS2, returnFirstFeasible: prevReturn2, adjAfterWeight: prevAdj, boundaryWeight: prevBoundary, bridgeWeight: prevBridge } } catch {}
    }
    try { window.SOLVER_FLAGS = { ...window.SOLVER_FLAGS, useDFSFirst: prevUseDFS, returnFirstFeasible: prevReturn } } catch {}
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
}

export async function captureCanvasPNG(canvas, triangles, startId, path){
  // 生成每一步的画布快照
  const off = document.createElement('canvas')
  off.width = canvas?.width || 800
  off.height = canvas?.height || 600
  const ctx = off.getContext('2d')
  const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
  const draw = (tris) => {
    ctx.clearRect(0,0,off.width,off.height)
    ctx.lineWidth=1; ctx.strokeStyle='#000'
    for(const t of tris){
      if (t.deleted || t.color==='transparent') continue
      ctx.beginPath()
      const verts = (t.drawVertices && t.drawVertices.length>=3) ? t.drawVertices : t.vertices
      ctx.moveTo(verts[0].x, verts[0].y)
      for(let i=1;i<verts.length;i++) ctx.lineTo(verts[i].x, verts[i].y)
      ctx.closePath(); ctx.fillStyle=t.color; ctx.fill(); ctx.stroke()
    }
  }
  const shots=[]
  let curColors = triangles.map(t=>t.color)
  for(const color of path){
    // flood fill
    const startColor = curColors[idToIndex.get(startId)]
    if(color===startColor){
      shots.push(off.toDataURL('image/png'))
      await new Promise(r=>setTimeout(r,0))
      continue
    }
    // 扩张区域
    const visited=new Set([startId])
    const q=[startId]
    const region=[]
    while(q.length){
      const id=q.shift()
      const idx=idToIndex.get(id)
      if(curColors[idx]!==startColor) continue
      region.push(id)
      for(const nb of triangles[idx].neighbors){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } }
    }
    for(const id of region){ curColors[idToIndex.get(id)] = color }
    const tris = triangles.map((t,i)=>({ ...t, color: curColors[i] }))
    draw(tris)
    shots.push(off.toDataURL('image/png'))
    // 让出事件循环，避免卡顿
    await new Promise(r=>setTimeout(r,0))
  }
  return shots
}

// 可选：RAG 驱动的增量扩张骨架（默认不启用）。
// 保持向后兼容：仅作为导出函数，不影响现有 attachSolverToWindow。
export function planRAGSearch(triangles, options = {}){
  const { enable = false } = options
  if (!enable) return { enabled: false }
  const rag = buildRAG(triangles)
  const freq = colorFrequency(triangles)
  // 分块规划骨架：先对图进行粗分块
  const blocks = partitionBlocks(triangles, { maxBlockSize: Math.max(32, Math.floor(triangles.length/20)) })
  const macro = planBlockAStar(triangles, blocks, options.startId ?? (triangles.find(t=>!t.deleted)?.id || 0), options.palette ?? Array.from(freq.keys()), options.onProgress)
  // 初始评分示例：根据组件边界度与颜色全局频率
  const compScores = rag.components.map((comp, i) => {
    const bd = rag.boundaryDegree[i] || 0
    const f = freq.get(comp.color) || 0
    const score = bd * 2 + f * 0.5
    return { compId: i, color: comp.color, score }
  }).sort((a,b)=> b.score - a.score)
  return { enabled: true, rag, freq, compScores, blocks, macro }
}