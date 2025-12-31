import { isUniform, buildRAG, colorFrequency } from './grid-utils'
import { getHeuristic } from './heuristics'
import { partitionBlocks, planBlockAStar } from './blocking'
import { mctsSolve } from './mcts'
import { satMacroColorPlan } from './sat'
import { UCBColorPrioritizer } from './learn'
import { localRepair } from './local-repair'
import { bitsetAlloc, bitsetSet, bitsetHas, bitsetCount, bitsetToIds, bitsetClone, bitsetForEach } from './bitset'
import { estimatePDB, hasPDB } from './pdb'

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

export function captureCanvasPNG(triangles, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  for(const t of triangles){
    if(t.deleted || t.color==='transparent') continue
    ctx.fillStyle = t.color
    ctx.beginPath()
    const v = t.drawVertices || t.vertices
    ctx.moveTo(v[0].x, v[0].y)
    ctx.lineTo(v[1].x, v[1].y)
    ctx.lineTo(v[2].x, v[2].y)
    ctx.closePath()
    ctx.fill()
  }
  return canvas.toDataURL('image/png')
}

function keyFromColors(colors){
  return colors.join(',')
}

export function attachSolverToWindow(){
  window.Solver_minSteps = async function Solver_minSteps(triangles, startId, palette, maxBranches=3, onProgress, stepLimit=Infinity){
    const startTime = Date.now()
    const TIME_BUDGET_MS = 300000
    let timedOut = false
    const nTris = triangles.length
    
    // Precompute indices for fast access
    const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
    const neighborIndices = new Array(nTris)
    for(let i=0; i<nTris; i++){
      const nbIds = triangles[i].neighbors
      const nbIndices = []
      for(const nid of nbIds){
        const idx = idToIndex.get(nid)
        if(idx != null) nbIndices.push(idx)
      }
      neighborIndices[i] = nbIndices
    }

    const startIdx = idToIndex.get(startId)
    const startColor = triangles[startIdx]?.color

    // Initial Region (BitSet)
    const region = bitsetAlloc(nTris)
    const visited = bitsetAlloc(nTris)
    const queue = [startIdx]
    if(startIdx != null) bitsetSet(visited, startIdx)
    
    let head = 0
    while(head < queue.length){
      const idx = queue[head++]
      const t = triangles[idx]
      if(t.deleted || t.color === 'transparent' || t.color !== startColor) continue
      bitsetSet(region, idx)
      const nbs = neighborIndices[idx]
      for(const nidx of nbs){
        if(!bitsetHas(visited, nidx)){
           bitsetSet(visited, nidx)
           queue.push(nidx)
        }
      }
    }

    const startColors = triangles.map(t=>t.color)
    const startKey = startColors.join(',')
    
    const seenBestG = new Map([[startKey, 0]])
    const globalTT = new Map([[startKey, { gMin: 0, fMin: 0 }]])
    
    const maxNodes = Math.min(20000, Math.max(8000, nTris * 8))
    const queueStates = [{ colors:startColors, region: region, steps: [] }]
    const solutions = []
    
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    const ENABLE_LB = !!FLAGS.enableLB
    const ENABLE_LOOKAHEAD = !!FLAGS.enableLookahead
    const ENABLE_LOOKAHEAD2 = !!FLAGS.enableLookaheadDepth2
    const ENABLE_INCREMENTAL = !!FLAGS.enableIncremental
    const ENABLE_BEAM = !!FLAGS.enableBeam
    const BEAM_WIDTH = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
    const ENABLE_BEST_FIRST = !!FLAGS.enableBestFirst
    const ENABLE_ASTAR_BF = Object.prototype.hasOwnProperty.call(FLAGS, 'useAStarInBestFirst') ? !!FLAGS.useAStarInBestFirst : !!ENABLE_BEST_FIRST
    const ENABLE_BRIDGE_FIRST = !!FLAGS.enableBridgeFirst
    const ADJ_AFTER_WEIGHT = Number.isFinite(FLAGS?.adjAfterWeight) ? FLAGS.adjAfterWeight : 0.6
    const BRIDGE_WEIGHT = Number.isFinite(FLAGS?.bridgeWeight) ? FLAGS.bridgeWeight : 1.0
    const GATE_WEIGHT = Number.isFinite(FLAGS?.gateWeight) ? FLAGS.gateWeight : 0.4
    const RICHNESS_WEIGHT = Number.isFinite(FLAGS?.richnessWeight) ? FLAGS.richnessWeight : 0.5
    const BOUNDARY_WEIGHT = Number.isFinite(FLAGS?.boundaryWeight) ? FLAGS.boundaryWeight : 0.8
    const USE_STRICT_LB_BF = !!FLAGS.strictMode || !!FLAGS.useStrongLBInBestFirst
    const ENABLE_ZERO_FILTER = (FLAGS.enableZeroExpandFilter !== false)
    const LOG_PERF = !!FLAGS.logPerf
    
    const RARE_FREQ_RATIO = Number.isFinite(FLAGS?.rareFreqRatio) ? FLAGS.rareFreqRatio : 0.03
    const RARE_FREQ_ABS = Number.isFinite(FLAGS?.rareFreqAbs) ? FLAGS.rareFreqAbs : 3
    const RARE_ALLOW_BRIDGE_MIN = Number.isFinite(FLAGS?.rareAllowBridgeMin) ? FLAGS.rareAllowBridgeMin : 2.0
    const RARE_ALLOW_GATE_MIN = Number.isFinite(FLAGS?.rareAllowGateMin) ? FLAGS.rareAllowGateMin : 1.0
    const MIN_DELTA_RATIO = Number.isFinite(FLAGS?.minDeltaRatio) ? FLAGS.minDeltaRatio : 0.02
    const LB_IMPROVE_MIN = Number.isFinite(FLAGS?.lbImproveMin) ? FLAGS.lbImproveMin : 1
    
    const REGION_CLASS_WEIGHTS = FLAGS?.regionClassWeights || { boundary: 0.8, bridge: 1.0, richness: 0.6 }
    const DIM_WEIGHTS = FLAGS?.dimensionWeights || { expand: 1.0, connect: 0.8, barrier: 0.7 }

    const RAG = buildRAG(triangles)
    const FREQ = colorFrequency(triangles)
    const COLOR_COMP_COUNT = new Map()
    for(const comp of RAG.components){ const c = comp.color; if(c){ COLOR_COMP_COUNT.set(c,(COLOR_COMP_COUNT.get(c)||0)+1) } }
    const getColorBias = (c)=> 1 / Math.max(1, (COLOR_COMP_COUNT.get(c)||1))

    // Helper: BitSet Iteration
    const regionForEach = (bs, fn) => bitsetForEach(bs, fn)
    const regionSize = (bs) => bitsetCount(bs)

    function computeAdjAfterSize(color, curColors, regionBS){
      const tmp = curColors.slice()
      regionForEach(regionBS, idx => { tmp[idx] = color })
      
      const newRegion = bitsetClone(regionBS)
      const q = []
      regionForEach(regionBS, idx => q.push(idx))
      
      const visited2 = bitsetClone(regionBS)
      
      let h=0
      while(h < q.length){
        const idx = q[h++]
        const nbs = neighborIndices[idx]
        for(const nidx of nbs){
           const tri = triangles[nidx]
           const cc = tmp[nidx]
           if(!bitsetHas(visited2, nidx) && !tri.deleted && tri.color!=='transparent' && cc===color){
             bitsetSet(visited2, nidx)
             bitsetSet(newRegion, nidx)
             q.push(nidx)
           }
        }
      }
      
      const adjSet = new Set()
      regionForEach(newRegion, idx => {
        const nbs = neighborIndices[idx]
        for(const nidx of nbs){
           const tri = triangles[nidx]
           const cc = tmp[nidx]
           if(!tri.deleted && cc && cc!=='transparent' && cc!==color){
             adjSet.add(cc)
           }
        }
      })
      return adjSet.size
    }

    function computeBridgePotential(color, curColors, regionBS){
      try{
        const tmp = curColors.slice()
        regionForEach(regionBS, idx => { tmp[idx] = color })
        
        const newRegion = bitsetClone(regionBS)
        const q = []
        regionForEach(regionBS, idx => q.push(idx))
        const visited2 = bitsetClone(regionBS)
        
        let h=0
        while(h < q.length){
          const idx = q[h++]
          const nbs = neighborIndices[idx]
          for(const nidx of nbs){
             const tri = triangles[nidx]
             const cc = tmp[nidx]
             if(!bitsetHas(visited2, nidx) && !tri.deleted && tri.color!=='transparent' && cc===color){
               bitsetSet(visited2, nidx)
               bitsetSet(newRegion, nidx)
               q.push(nidx)
             }
          }
        }
        
        const seenComps = new Set()
        const gateContacts = new Map()
        
        regionForEach(newRegion, idx => {
           const nbs = neighborIndices[idx]
           for(const nidx of nbs){
              const cj = RAG.triToComp[nidx]
              if(cj!=null){
                 seenComps.add(cj)
                 gateContacts.set(cj, (gateContacts.get(cj)||0)+1)
              }
           }
        })

        let bridgePotential = 0
        let gateScore = 0
        for(const compId of seenComps){
          const comp = RAG.components[compId]
          if(!comp) continue
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

    const lbCache = new Map()
    function lowerBound(colors){
      const key = colors.join(',')
      const cached = lbCache.get(key)
      if (cached!=null) return cached
      const s = new Set()
      for(let i=0;i<nTris;i++){
        const t = triangles[i]; const c = colors[i]
        if(!t.deleted && c && c !== 'transparent') s.add(c)
      }
      const lb = Math.max(0, s.size - 1)
      lbCache.set(key, lb)
      return lb
    }

    function boundaryDistinct(colors, regionBS){
      const rc = colors[startIdx]
      const set = new Set()
      regionForEach(regionBS, idx => {
         const nbs = neighborIndices[idx]
         for(const nidx of nbs){
           const tri = triangles[nidx]
           const c = colors[nidx]
           if(c!==rc && c && c!=='transparent' && !tri.deleted){ set.add(c) }
         }
      })
      return set.size
    }

    function lowerBoundStrictLocal(colors, regionBS){
      let activeCount = 0
      const colorFreq = new Map()
      for(let i=0;i<nTris;i++){
        const t=triangles[i]; const c=colors[i]
        if(!t.deleted && c && c!=='transparent'){
          activeCount++
          colorFreq.set(c, (colorFreq.get(c)||0)+1)
        }
      }
      const lbColors = Math.max(0, colorFreq.size - 1)
      const rc = colors[startIdx]
      const frontier = new Set()
      
      regionForEach(regionBS, idx => {
         const nbs = neighborIndices[idx]
         for(const nidx of nbs){
            const tri = triangles[nidx]
            const cc = colors[nidx]
            if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ frontier.add(cc) }
         }
      })
      
      const lbFrontier = frontier.size
      const remaining = Math.max(0, activeCount - regionSize(regionBS))
      let maxColorCount = 0
      for(const v of colorFreq.values()){ if(v>maxColorCount) maxColorCount=v }
      const lbArea = maxColorCount>0 ? Math.ceil(remaining / maxColorCount) : 0
      return Math.max(lbColors, lbFrontier, lbArea)
    }

    let nodes = 0
    let maxDepth = 0
    const perf = { filteredZero: 0, expanded: 0, enqueued: 0, lbHist: { improve0: 0, improve1_2: 0, improve3_5: 0, improve6p: 0 }, queueMax: 0, depthMax: 0 }
    
    while(queueStates.length && nodes<maxNodes){
      if (nodes % 300 === 0) {
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
      if (cur.steps.length >= (Number.isFinite(stepLimit) ? stepLimit : Infinity)) continue
      if (ENABLE_LB && Number.isFinite(stepLimit)){
        const lb = USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, cur.region) : lowerBound(curColors)
        if (cur.steps.length + lb > stepLimit) continue
      }
      
      // Fast isUniform check
      let uni = true; let first = null
      for(let i=0; i<nTris; i++){
         const t=triangles[i]; const c=curColors[i]
         if(t.deleted || c==='transparent') continue
         if(first===null) first=c
         else if(c!==first){ uni=false; break }
      }
      if(uni){
         if ((typeof window !== 'undefined' && window.SOLVER_FLAGS?.returnFirstFeasible) && Number.isFinite(stepLimit)) {
           if (onProgress) try { onProgress({ phase: 'solution', minSteps: cur.steps.length, solutions: 1, elapsedMs: Date.now() - startTime }) } catch {}
           return { paths: [cur.steps], minSteps: cur.steps.length, timedOut }
         }
         solutions.push(cur.steps)
         const minLen = solutions[0].length
         const sameLen = solutions.filter(s=>s.length===minLen)
         if (onProgress) try { onProgress({ phase: 'solution', minSteps: minLen, solutions: sameLen.length, elapsedMs: Date.now() - startTime }) } catch {}
         if(sameLen.length>=maxBranches) break
         else continue
      }
      
      const regionBS = cur.region
      const regionColor = curColors[startIdx]
      
      const adjColors = new Set()
      const gain = new Map()
      
      if (ENABLE_INCREMENTAL && cur.boundaryNeighbors) {
        for (const idx of cur.boundaryNeighbors) {
          const tri = triangles[idx]
          const c = curColors[idx]
          if (c!==regionColor && c && c!=='transparent' && !tri.deleted){
            adjColors.add(c)
            gain.set(c, (gain.get(c) || 0) + 1)
          }
        }
      } else {
        regionForEach(regionBS, idx => {
          const nbs = neighborIndices[idx]
          for(const nidx of nbs){
             const tri = triangles[nidx]
             const c = curColors[nidx]
             if (c!==regionColor && c && c!=='transparent' && !tri.deleted){
                adjColors.add(c)
                gain.set(c, (gain.get(c) || 0) + 1)
             }
          }
        })
      }
      
      const colorCount = new Map()
      for(let i=0; i<nTris; i++){
         const t=triangles[i]; const c=t.color
         if(!t.deleted && c && c!=='transparent') colorCount.set(c, (colorCount.get(c)||0)+1)
      }
      
      const tryColorsRaw = adjColors.size>0 ? [...adjColors] : palette
      const boundaryBefore = boundaryDistinct(curColors, regionBS)
      const basePreK = Math.max(4, Math.min(8, 4 + Math.floor((adjColors.size||0)/3) + (boundaryBefore>6?2:0)))
      const depth = cur.steps.length
      const beamBase = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
      const beamDecay = Number.isFinite(FLAGS?.beamDecay) ? FLAGS.beamDecay : 0.85
      const beamMin = Number.isFinite(FLAGS?.beamMin) ? FLAGS.beamMin : 4
      const pressure = Math.min(1, queueStates.length / Math.max(1, maxNodes))
      const pressureScale = ENABLE_BEAM ? Math.max(0.6, 1.0 - 0.5*pressure) : 1.0
      const dynamicWidth = ENABLE_BEAM ? Math.max(beamMin, Math.floor(beamBase * Math.pow(beamDecay, depth) * pressureScale)) : beamBase
      const preK = ENABLE_BEAM ? Math.min(dynamicWidth, basePreK) : basePreK
      
      const prelim = tryColorsRaw.map(c=>{
        const g = (gain.get(c)||0)
        const score0 = g*3 + getColorBias(c)
        return { c, score0, gain:g }
      }).sort((a,b)=> b.score0 - a.score0).slice(0, preK)
      
      // Enlarge & Saddle Potential (Simplified for BitSet)
      const regionBoundaryNeighbors = [] // indices
      regionForEach(regionBS, idx => {
         const nbs = neighborIndices[idx]
         for(const nidx of nbs){
            if(curColors[nidx] !== regionColor) regionBoundaryNeighbors.push(nidx)
         }
      })
      
      const enlargePotential = new Map()
      for(const {c} of prelim){
         const seeds = []
         for(const idx of regionBoundaryNeighbors){
            if(curColors[idx]===c) seeds.push(idx)
         }
         const seedSet = new Set(seeds)
         const visitedB = new Set()
         let compCountB = 0
         for(const s of seeds){
            if(visitedB.has(s)) continue
            compCountB++
            const qB = [s]; visitedB.add(s)
            while(qB.length){
               const u = qB.shift()
               const nbs = neighborIndices[u]
               for(const v of nbs){
                  if(seedSet.has(v) && !visitedB.has(v) && curColors[v]===c){
                     visitedB.add(v); qB.push(v)
                  }
               }
            }
         }
         const boundarySeedCount = seeds.length
         enlargePotential.set(c, boundarySeedCount * 1.0 + Math.max(0, boundarySeedCount - compCountB) * 0.5)
      }
      
      const saddlePotential = new Map()
      for(const {c} of prelim){
         const seeds = []
         for(const idx of regionBoundaryNeighbors){
            if(curColors[idx]===c) seeds.push(idx)
         }
         const visitedS = new Set()
         const compSizes = []
         for(const s of seeds){
            if(visitedS.has(s)) continue
            let size = 0
            const qS = [s]; visitedS.add(s)
            while(qS.length){
               const u = qS.shift(); size++
               const nbs = neighborIndices[u]
               for(const v of nbs){
                  if(!visitedS.has(v) && curColors[v]===c){
                     visitedS.add(v); qS.push(v)
                  }
               }
            }
            compSizes.push(size)
         }
         compSizes.sort((a,b)=>b-a)
         saddlePotential.set(c, compSizes.length)
      }

      const baseLimitTry = Math.max(6, Math.min(10, 6 + Math.floor((adjColors.size||0)/3) + (boundaryBefore>6?2:0)))
      let limitTry = ENABLE_BEAM ? Math.min(dynamicWidth, baseLimitTry) : baseLimitTry
      const prevLB = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(curColors, regionBS) : lowerBound(curColors)) : 0
      const BF_W = Number.isFinite(window?.SOLVER_FLAGS?.bifrontWeight) ? window.SOLVER_FLAGS.bifrontWeight : 2.0
      
      const scored = prelim.map(({c, gain})=>{
         const pot = (enlargePotential.get(c)||0)
         const saddle = (saddlePotential.get(c)||0)
         let score = gain*3 + pot*2 + saddle*BF_W + getColorBias(c)
         
         if(ENABLE_BRIDGE_FIRST){
            const adjAfter = computeAdjAfterSize(c, curColors, regionBS)
            const { bridgePotential, gateScore } = computeBridgePotential(c, curColors, regionBS)
            const boundaryAfter = adjAfter
            score += (boundaryBefore - boundaryAfter) * BOUNDARY_WEIGHT
            score += adjAfter * ADJ_AFTER_WEIGHT + bridgePotential * BRIDGE_WEIGHT + gateScore * GATE_WEIGHT
         }
         // PDB Integration
         const pdbScore = estimatePDB('dynamic_rag', { triangles, idToIndex, neighbors: triangles.map(t=>t.neighbors), startId, boundaryNeighbors: regionBoundaryNeighbors }, curColors, bitsetToIds(regionBS, triangles))
         score += pdbScore * 2.0 

         return { c, score }
      }).sort((a,b)=> b.score - a.score).map(x=>({ c:x.c, score:x.score }))
      
      const tryColors = scored.slice(0, limitTry).map(x=>x.c)
      
      for(const color of tryColors){
         if(color===regionColor) continue
         const nextColors = curColors.slice()
         regionForEach(regionBS, idx => { nextColors[idx] = color })
         const key = nextColors.join(',')
         const gNext = cur.steps.length + 1
         
         const prevG = seenBestG.get(key)
         if(prevG != null && prevG <= gNext) continue
         
         const newRegion = bitsetClone(regionBS)
         const q = []
         regionForEach(regionBS, idx => q.push(idx))
         const visited2 = bitsetClone(regionBS)
         
         let h=0
         while(h < q.length){
            const idx = q[h++]
            const nbs = neighborIndices[idx]
            for(const nidx of nbs){
               const tri = triangles[nidx]
               if(!bitsetHas(visited2, nidx) && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){
                  bitsetSet(visited2, nidx)
                  bitsetSet(newRegion, nidx)
                  q.push(nidx)
               }
            }
         }
         
         const nextSteps = [...cur.steps, color]
         if (nextSteps.length > maxDepth) maxDepth = nextSteps.length
         
         const delta = bitsetCount(newRegion) - bitsetCount(regionBS)
         if (ENABLE_ZERO_FILTER && delta <= 0) { perf.filteredZero++; continue }
         if (delta / Math.max(1, bitsetCount(regionBS)) < MIN_DELTA_RATIO) continue
         
         let nextBoundaryNeighbors = null
         if (ENABLE_INCREMENTAL) {
            const boundarySet = new Set()
            regionForEach(newRegion, idx2 => {
               const nbs2 = neighborIndices[idx2]
               for(const nidx2 of nbs2){
                  const c2 = nextColors[nidx2]
                  const tri2 = triangles[nidx2]
                  if(c2!==color && c2 && c2!=='transparent' && !tri2.deleted){
                     boundarySet.add(nidx2)
                  }
               }
            })
            nextBoundaryNeighbors = Array.from(boundarySet)
         }
         
         let baseScore = (gain.get(color)||0)*3
         const childLB = ENABLE_LB ? (USE_STRICT_LB_BF ? lowerBoundStrictLocal(nextColors, newRegion) : lowerBound(nextColors)) : 0
         if (ENABLE_LB && (prevLB - childLB) < LB_IMPROVE_MIN) continue
         
         const fNext = gNext + childLB
         const prevTT = globalTT.get(key)
         if (prevTT && ((prevTT.gMin ?? Infinity) <= gNext || (prevTT.fMin ?? Infinity) <= fNext)) continue
         
         const priority = baseScore - childLB * 2
         queueStates.push({ colors: nextColors, region: newRegion, steps: nextSteps, boundaryNeighbors: nextBoundaryNeighbors, priority, g: gNext, h: childLB, f: fNext })
         
         const gMin = Math.min(prevTT?.gMin ?? Infinity, gNext)
         const fMin = Math.min(prevTT?.fMin ?? Infinity, fNext)
         globalTT.set(key, { gMin, fMin })
         seenBestG.set(key, gNext)
         perf.enqueued++
         perf.expanded += Math.max(0, delta)
      }
      
      if (ENABLE_BEST_FIRST) {
         if (ENABLE_ASTAR_BF) {
            queueStates.sort((a,b)=>{
               const df = (a.f ?? Infinity) - (b.f ?? Infinity)
               if (df !== 0) return df
               return (b.priority ?? -Infinity) - (a.priority ?? -Infinity)
            })
         } else {
            queueStates.sort((a,b)=> (b.priority ?? -Infinity) - (a.priority ?? -Infinity))
         }
      }
    }
    
    if(solutions.length===0){
        // Simplified Greedy Fallback
        const steps = []
        let curColors = startColors.slice()
        let curRegion = bitsetClone(region)
        let limit = Number.isFinite(stepLimit) ? stepLimit : 100
        while(limit-- > 0){
             let bestC = null; let bestGain = -1
             const gain = new Map()
             regionForEach(curRegion, idx => {
                const nbs = neighborIndices[idx]
                for(const nidx of nbs){
                   const c = curColors[nidx]
                   const t = triangles[nidx]
                   if(c!==startColor && c && c!=='transparent' && !t.deleted){
                      gain.set(c, (gain.get(c)||0)+1)
                   }
                }
             })
             if(gain.size===0) break
             for(const [c, g] of gain.entries()){ if(g>bestGain){ bestGain=g; bestC=c } }
             if(!bestC) break
             steps.push(bestC)
             regionForEach(curRegion, idx => { curColors[idx] = bestC })
             const q = []
             regionForEach(curRegion, idx => q.push(idx))
             const visited2 = bitsetClone(curRegion)
             const newRegion = bitsetClone(curRegion)
             let h=0
             while(h<q.length){
                const idx=q[h++]
                for(const nidx of neighborIndices[idx]){
                   if(!bitsetHas(visited2, nidx) && !triangles[nidx].deleted && triangles[nidx].color!=='transparent' && curColors[nidx]===bestC){
                      bitsetSet(visited2, nidx); bitsetSet(newRegion, nidx); q.push(nidx)
                   }
                }
             }
             curRegion = newRegion
             // fast isUniform check
             let uni = true; let first = null
             for(let i=0; i<nTris; i++){
                const t=triangles[i]; const c=curColors[i]
                if(t.deleted || c==='transparent') continue
                if(first===null) first=c
                else if(c!==first){ uni=false; break }
             }
             if(uni) return { paths: [steps], minSteps: steps.length, timedOut }
        }
    }

    const minSteps = solutions[0]?.length || 0
    const paths = solutions.filter(s=>s.length===minSteps).slice(0, maxBranches)
    if (LOG_PERF) try { console.log('[Solver] Perf', { nodes, enqueued: perf.enqueued, expanded: perf.expanded, filteredZero: perf.filteredZero, elapsedMs: Date.now() - startTime }) } catch {}
    
    return { paths, minSteps, timedOut }
  }

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
      for(const tid of regionIds(region)){
        const idx=idToIndex.get(tid)
        for(const nb of neighbors[idx]){
          const nidx=idToIndex.get(nb); const tri=triangles[nidx]; const cc=colors[nidx]
          if(cc!==rc && cc && cc!=='transparent' && !tri.deleted){ frontier.add(cc) }
        }
      }
      const lbFrontier = frontier.size
      const lbBridge = lbFrontier
      const remaining = Math.max(0, activeCount - regionSize(region))
      let maxColorCount = 0
      for(const v of colorFreq.values()){ if(v>maxColorCount) maxColorCount=v }
      const lbArea = maxColorCount>0 ? Math.ceil(remaining / maxColorCount) : 0
      return Math.max(lbColors, lbFrontier, lbArea, lbBridge)
    }
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
        const nextColors = cur.colors.slice();
        for(const id of regionIds(cur.region)){ nextColors[idToIndex.get(id)] = color }
        let newRegion
        if (USE_BITSET && !(cur.region instanceof Set)){
          const bs = bitsetAlloc(triangles.length)
          for(const id of regionIds(cur.region)){ const ii=idToIndex.get(id); if(ii!=null) bitsetSet(bs, ii) }
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

  window.StrictIDAStarMinSteps = async function(triangles, startId, palette, onProgress, stepLimit=Infinity){
    const startTime = Date.now()
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    const TIME_BUDGET_MS = Math.min(18000, 4000 + triangles.length * 10)
    const REPORT_INTERVAL_MS = Number.isFinite(FLAGS?.progressAStarIntervalMs) ? Math.max(0, FLAGS.progressAStarIntervalMs) : 250
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
      const lbBridge = lbFrontier
      const remaining = Math.max(0, activeCount - regionSize(region))
      let maxColorCount = 0; for(const v of colorFreq.values()){ if(v>maxColorCount) maxColorCount=v }
      const lbArea = maxColorCount>0 ? Math.ceil(remaining / maxColorCount) : 0
      return Math.max(lbColors, lbFrontier, lbArea, lbBridge)
    }
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

    const globalTT = new Map()
    const perf = { expanded: 0, prunedBound: 0, prunedTTG: 0, prunedTTF: 0, prunedStepLimit: 0 }

    const startRegion = buildRegion(startColors)
    const h0 = lowerBoundStrict(startColors, startRegion)
    if (Number.isFinite(stepLimit) && h0 > stepLimit) { return { paths: [], minSteps: 0, timedOut } }
    let bound = h0
    let lastReport = startTime

    async function dfs(colors, regionSet, g, boundCur, path, tt, boundaryNeighbors){
      const nowTs = Date.now()
      if (nowTs - startTime > TIME_BUDGET_MS) { timedOut = true; return { found:false, nextBound: Infinity, path: null } }
      if (REPORT_INTERVAL_MS<=0 || (nowTs - lastReport) >= REPORT_INTERVAL_MS){
        lastReport = nowTs
        try { onProgress?.({ phase:'strict_idastar', depth: maxDepth, bound: boundCur, elapsedMs: nowTs - startTime, perf }) } catch {}
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
      const basePreK = 6
      const prelim = tryColorsRaw.map(c=>{
        const g0=(gain.get(c)||0)
        const score0=g0*3 + getBiasStrict(c)
        return { c, score0, gain:g0 }
      }).sort((a,b)=> b.score0 - a.score0).slice(0, basePreK)
      const tryColors = prelim.map(x=>x.c)
      let minNextBound = Infinity
      for(const color of tryColors){ if(color===rc) continue
        const nextColors = colors.slice();
        for(const id of regionIds(regionSet)){ nextColors[idToIndex.get(id)] = color }
        let newRegion
        if (USE_BITSET && !(regionSet instanceof Set)){
          const bs = bitsetAlloc(triangles.length)
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
        perf.expanded++
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
        for(const tid of regionIds(startRegion)){ const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); if(nidx==null) continue; if(startColors[nidx]!==rc0){ bset.add(nb) } } }
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
  
  window.Solver_minStepsAuto = async function(triangles, palette, maxBranches=3, onProgress, stepLimit=Infinity){
    const startTime = Date.now()
    const TIME_BUDGET_MS = (typeof window !== 'undefined' && window.SOLVER_FLAGS && Number.isFinite(window.SOLVER_FLAGS.workerTimeBudgetMs))
      ? Math.max(1000, window.SOLVER_FLAGS.workerTimeBudgetMs)
      : 300000
    let timedOut = false
    const FLAGS = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS : {}
    const SCHED_INTERVAL_MS = Number.isFinite(FLAGS?.dynamicScheduleIntervalMs) ? Math.max(500, FLAGS.dynamicScheduleIntervalMs) : 2500
    const ADJUST_ON_NO_PROGRESS = (FLAGS?.dynamicBeamAdjustOnNoBestUpdate !== false)
    let lastBestUpdateTs = startTime
    const baseBeamWidth = Number.isFinite(FLAGS?.beamWidth) ? FLAGS.beamWidth : 12
    const baseLbImproveMin = Number.isFinite(FLAGS?.lbImproveMin) ? FLAGS.lbImproveMin : 1
    const baseBeamMin = Number.isFinite(FLAGS?.beamMin) ? FLAGS.beamMin : 4
    const beamMax = Number.isFinite(FLAGS?.beamMax) ? FLAGS.beamMax : 64
    const beamScheduleTargets = Array.isArray(FLAGS?.beamScheduleTargets) ? FLAGS.beamScheduleTargets : [32, 40, 48]
    let beamScheduleIdx = 0
    const PREPROC_TIME_BUDGET_MS = Number.isFinite(FLAGS?.preprocessTimeBudgetMs)
      ? Math.max(0, FLAGS.preprocessTimeBudgetMs)
      : 300000
    const PROG_COMP_INTERVAL = Number.isFinite(FLAGS?.progressComponentsIntervalMs) ? Math.max(0, FLAGS.progressComponentsIntervalMs) : 100
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
        if ((Date.now() - startTime) > PREPROC_TIME_BUDGET_MS) {
          break
        }
        const cid=q.shift()
        const idx=idToIndex.get(cid)
        const tri=triangles[idx]
        if(tri.deleted || tri.color==='transparent' || tri.color!==color) continue
        comp.push(cid)
        for(const nb of neighbors[idx]){ if(!visited.has(nb)){ const nidx=idToIndex.get(nb); const tri2=triangles[nidx]; if(!tri2.deleted && tri2.color!=='transparent' && tri2.color===color){ visited.add(nb); q.push(nb) } } }
        if (onProgress) {
          const nowTs = Date.now()
          if (PROG_COMP_INTERVAL <= 0 || (nowTs - compLastTs) >= PROG_COMP_INTERVAL) {
            compLastTs = nowTs
            onProgress({ phase:'components_build', count: components.length, compSize: comp.length, color, elapsedMs: nowTs - startTime })
            await new Promise(r=>setTimeout(r,0))
          }
        }
      }
      if(comp.length>0){
        components.push({ color, ids: comp, startId: comp[0], size: comp.length })
        const nowTs = Date.now()
        if (onProgress) {
          if (PROG_COMP_INTERVAL <= 0 || (nowTs - compLastTs) >= PROG_COMP_INTERVAL) {
            compLastTs = nowTs
            onProgress({ phase:'components', count: components.length, elapsedMs: nowTs - startTime })
            await new Promise(r=>setTimeout(r,0))
          } else {
            onProgress({ phase:'components', count: components.length, elapsedMs: nowTs - startTime })
          }
        }
      }
    }
    {
      const nowTs = Date.now()
      const largest = components.length>0 ? components.reduce((m,c)=> Math.max(m, c.size||0), 0) : 0
      const summary = { phase:'components_done', count: components.length, largest, elapsedMs: nowTs - startTime }
      try { onProgress?.(summary) } catch {}
    }
    const COLOR_COMP_COUNT = new Map()
    for (const comp of components) {
      const c = comp.color
      if (c) COLOR_COMP_COUNT.set(c, (COLOR_COMP_COUNT.get(c)||0)+1)
    }
    const getColorBiasRAG = (c)=> 1 / Math.max(1, (COLOR_COMP_COUNT.get(c)||1))
    {
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
      if (ENABLE_ANALYSIS_ORDER) {
        const dispersionByColor = new Map(colorsSummary.map(s=>[s.color, s.dispersion]))
        components.sort((a,b)=>{
          const da = dispersionByColor.get(a.color) || 0
          const db = dispersionByColor.get(b.color) || 0
          const aBridge = (compDetails.find(d=>d.startId===a.startId)?.bridgeDensity || 0) >= BRIDGE_DENSITY_THRESH
          const bBridge = (compDetails.find(d=>d.startId===b.startId)?.bridgeDensity || 0) >= BRIDGE_DENSITY_THRESH
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
    try {
      const preferred = (typeof window !== 'undefined' && window.SOLVER_FLAGS) ? window.SOLVER_FLAGS.preferredStartId : null
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
      if (ADJUST_ON_NO_PROGRESS) {
        const now = Date.now()
        if (now - lastBestUpdateTs >= SCHED_INTERVAL_MS) {
          try {
            const curBeam = Number.isFinite(window.SOLVER_FLAGS?.beamWidth) ? window.SOLVER_FLAGS.beamWidth : baseBeamWidth
            const target = (Array.isArray(beamScheduleTargets) && beamScheduleIdx < beamScheduleTargets.length) ? Math.max(curBeam, beamScheduleTargets[beamScheduleIdx]) : (curBeam + 8)
            const newBeam = Math.min(beamMax, Math.max(curBeam, target))
            window.SOLVER_FLAGS.beamWidth = newBeam
            beamScheduleIdx = Math.min(beamScheduleIdx + 1, (beamScheduleTargets?.length || 0))
            const curLbMin = Number.isFinite(window.SOLVER_FLAGS?.lbImproveMin) ? window.SOLVER_FLAGS.lbImproveMin : baseLbImproveMin
            window.SOLVER_FLAGS.lbImproveMin = Math.max(1, curLbMin - 1)
            const curBeamMin = Number.isFinite(window.SOLVER_FLAGS?.beamMin) ? window.SOLVER_FLAGS.beamMin : baseBeamMin
            window.SOLVER_FLAGS.beamMin = Math.min(baseBeamMin, curBeamMin + 1)
            onProgress?.({ phase:'scheduler_adjust', beamWidth: newBeam, lbImproveMin: window.SOLVER_FLAGS.lbImproveMin, beamMin: window.SOLVER_FLAGS.beamMin, elapsedMs: now - startTime })
            lastBestUpdateTs = now
          } catch {}
        }
      }
      if (Number.isFinite(stepLimit)) {
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
            if (lbLocalStart > stepLimit) {
              onProgress?.({ phase:'start_pruned', reason:'lb_local_over', startId: comp.startId, lbLocal: lbLocalStart, stepLimit })
              continue
            }
          }
        } catch {}
      }
      if (FLAGS.strictMode) {
        const useIDA = !!FLAGS.useIDAStar
        const resStrict = useIDA
          ? await window.StrictIDAStarMinSteps(triangles, comp.startId, palette, (p)=>{ onProgress?.({ phase:'subsearch', startId: comp.startId, ...p }) }, stepLimit)
          : await window.StrictAStarMinSteps(triangles, comp.startId, palette, (p)=>{ onProgress?.({ phase:'subsearch', startId: comp.startId, ...p }) }, stepLimit)
        if(resStrict && resStrict.paths && resStrict.paths.length>0){
          if(resStrict.minSteps < best.minSteps){ best = { startId: comp.startId, minSteps: resStrict.minSteps, paths: resStrict.paths }; onProgress?.({ phase:'best_update', bestStartId: best.startId, minSteps: best.minSteps }); lastBestUpdateTs = Date.now(); if (ADJUST_ON_NO_PROGRESS) { try { window.SOLVER_FLAGS.beamWidth = baseBeamWidth; window.SOLVER_FLAGS.lbImproveMin = baseLbImproveMin; const curBeamMin = Number.isFinite(window.SOLVER_FLAGS?.beamMin) ? window.SOLVER_FLAGS.beamMin : baseBeamMin; window.SOLVER_FLAGS.beamMin = Math.max(2, Math.min(baseBeamMin, curBeamMin - 1)); beamScheduleIdx = 0; onProgress?.({ phase:'scheduler_reset', beamWidth: window.SOLVER_FLAGS.beamWidth, lbImproveMin: window.SOLVER_FLAGS.lbImproveMin, beamMin: window.SOLVER_FLAGS.beamMin }) } catch {} } }
          if (Number.isFinite(stepLimit) && resStrict.minSteps <= stepLimit) { break }
          if (resStrict.timedOut) timedOut = true
        }
        continue
      }
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
            return raw.sort((a,b)=>score(b)-score(a)).slice(0,8).filter(c=>c!==rc)
          }
          const startTs = Date.now()
          let dfsNodesFirst = 0
          async function dfs(colors, regionSet, steps){
            if(isUniform(colors.map((c,i)=>({color:c,id:i,neighbors:neighbors[i]})))) return steps
            if(steps.length>=stepLimit) return null
            if(Date.now()-startTs > TIME_BUDGET_MS) { timedOut = true; return null }
            const tryColors = orderColors(colors, regionSet)
            for(const color of tryColors){
              const nextColors = colors.slice(); for(const id of regionSet) nextColors[idToIndex.get(id)] = color
              const key = keyFromColors(nextColors); if(seen.has(key)) continue; seen.add(key)
              const q=[...regionSet]; const newRegion=new Set([...regionSet]); const visited2 = new Uint8Array(triangles.length); for(const id of regionSet){ const ii=idToIndex.get(id); if(ii!=null) visited2[ii]=1 }
              while(q.length){ const tid=q.shift(); const idx=idToIndex.get(tid); for(const nb of neighbors[idx]){ const nidx=idToIndex.get(nb); const tri=triangles[nidx]; if(!visited2[nidx] && !tri.deleted && tri.color!=='transparent' && nextColors[nidx]===color){ visited2[nidx]=1; newRegion.add(nb); q.push(nb) } }
              }
              dfsNodesFirst++
              const res = await dfs(nextColors, newRegion, [...steps,color]); if(res) return res
              await new Promise(r=>setTimeout(r,0))
            }
            return null
          }
          const dfsRegion = buildRegion(startColors)
          const dfsRes = await dfs(startColors, dfsRegion, [])
          if(dfsRes){
            const RETURN_FIRST = !!FLAGS.returnFirstFeasible
            onProgress?.({ phase:'dfs_first_solution', minSteps: dfsRes.length, solutions: 1, elapsedMs: Date.now() - startTime })
            if (RETURN_FIRST) {
              return { paths:[dfsRes], minSteps: dfsRes.length, timedOut }
            }
          }
          return null
        })()
        if (resDFS && resDFS.paths && resDFS.paths.length>0) {
          return { bestStartId: comp.startId, paths: resDFS.paths, minSteps: resDFS.minSteps, timedOut }
        }
      }
      const res = await window.Solver_minSteps(triangles, comp.startId, palette, maxBranches, (p)=>{
        onProgress?.({ phase:'subsearch', startId: comp.startId, ...p })
      }, stepLimit)
      if(res && res.paths && res.paths.length>0){
        if(res.minSteps < best.minSteps){ best = { startId: comp.startId, minSteps: res.minSteps, paths: res.paths }; onProgress?.({ phase:'best_update', bestStartId: best.startId, minSteps: best.minSteps }); lastBestUpdateTs = Date.now(); if (ADJUST_ON_NO_PROGRESS) { try { window.SOLVER_FLAGS.beamWidth = baseBeamWidth; window.SOLVER_FLAGS.lbImproveMin = baseLbImproveMin; const curBeamMin = Number.isFinite(window.SOLVER_FLAGS?.beamMin) ? window.SOLVER_FLAGS.beamMin : baseBeamMin; window.SOLVER_FLAGS.beamMin = Math.max(2, Math.min(baseBeamMin, curBeamMin - 1)); beamScheduleIdx = 0; onProgress?.({ phase:'scheduler_reset', beamWidth: window.SOLVER_FLAGS.beamWidth, lbImproveMin: window.SOLVER_FLAGS.lbImproveMin, beamMin: window.SOLVER_FLAGS.beamMin }) } catch {} } }
        if (Number.isFinite(stepLimit) && res.minSteps <= stepLimit) {
          break
        }
        if (res.timedOut) timedOut = true
      }
    }
    if(best.minSteps===Infinity) return { bestStartId: null, paths: [], minSteps: 0, timedOut }
    return { bestStartId: best.startId, paths: best.paths, minSteps: best.minSteps, timedOut }
  }
}
