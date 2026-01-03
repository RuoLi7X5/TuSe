import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

import UploadPanel from './components/UploadPanel'
import TriangleCanvas from './components/TriangleCanvas'
import Controls from './components/Controls'
import StepsPanel from './components/StepsPanel'
import HelpPage from './components/HelpPage'
import AdminDashboard from './components/AdminDashboard'

import { quantizeImage, setColorTuning } from './utils/color-utils'
import { buildTriangleGrid, buildTriangleGridVertical, mapImageToGrid, isUniform, colorFrequency, generateAiDebugImage, rectifyColorsByGrid, exportGridOverlay } from './utils/grid-utils'
import { floodFillRegion, attachSolverToWindow, captureCanvasPNG } from './utils/solver'
import { detectGrid } from './utils/grid-detector'
import { computeRegionStats, renderRegionStatsSnapshotPNG } from './utils/region-stats'
import { hasPDB, loadPDBObject, loadPDBFromJSON, loadPDBFromURL, getPDBBaseURL } from './utils/pdb'
import { startRun as telemetryStartRun, logEvent as telemetryLogEvent, finishRun as telemetryFinishRun, makeGraphSignature, getRecommendation, uploadStrategyAuto, recordRunScore, postLearnScore } from './utils/telemetry'
import { getCachedSolution, saveCachedSolutionWithPuzzle, makePuzzlePayload, startCacheSyncLoop, deleteCachedSolutionEverywhere, clearAllCachedSolutionsLocal } from './utils/solutionCache'
import { saveQualifiedSolveLog, listQualifiedSolveLogs, getQualifiedSolveLog, deleteQualifiedSolveLog } from './utils/solveLogStore'
import AIService from './utils/ai-service'

// 逐步生成快照：返回 images 数组（包含初始状态 + 每一步后的状态）。
// 注意：StepsPanel 期待 branch.images 是“图片数组”，不要再塞成 [singleImage]。
async function buildStepSnapshots({ triangles, width, height, startId, path, maxSnap = 200, includeInitial = true }) {
  const p = Array.isArray(path) ? path : []
  const take = Math.min(p.length, Math.max(1, Math.floor(maxSnap)))
  const snaps = []
  if (includeInitial) snaps.push(await captureCanvasPNG(triangles, width, height, startId, []))
  const cur = []
  for (let k = 0; k < take; k++) {
    cur.push(p[k])
    snaps.push(await captureCanvasPNG(triangles, width, height, startId, cur))
    if (k % 5 === 0) await new Promise(r => setTimeout(r, 0))
  }
  // 太长时：补一张最终状态，避免只看到前半段
  if (p.length > take) snaps.push(await captureCanvasPNG(triangles, width, height, startId, p))
  return snaps
}

// 校验：给定起点与步骤（兼容 action steps 与 legacy steps），模拟涂色后判断是否统一。
function verifyUnifiedPath({ triangles, startId, path }) {
  try {
    if (startId == null || !Array.isArray(path) || path.length === 0) return false
    const idToIndex = new Map(triangles.map((t, i) => [t.id, i]))
    const neighbors = triangles.map(t => t.neighbors)
    let colorsLocal = triangles.map(t => t.color)
    const applyOne = (sid, stepColor) => {
      const idxStart = idToIndex.get(sid)
      if (idxStart == null) return false
      const startColorCur = colorsLocal[idxStart]
      if (stepColor === startColorCur) return true
      const regionSet = new Set()
      const q = [sid]
      const visited = new Set([sid])
      while (q.length) {
        const id = q.shift()
        const idx = idToIndex.get(id)
        if (idx == null) return false
        if (colorsLocal[idx] !== startColorCur) continue
        regionSet.add(id)
        const nbs = neighbors[idx] || []
        for (const nb of nbs) {
          if (!visited.has(nb)) { visited.add(nb); q.push(nb) }
        }
      }
      if (regionSet.size === 0) return false
      for (const id of regionSet) { colorsLocal[idToIndex.get(id)] = stepColor }
      return true
    }
    for (const step of path) {
      const isObj = step && typeof step === 'object'
      const sid = isObj ? step.startId : startId
      const stepColor = isObj ? step.color : step
      if (sid == null || !stepColor) return false
      if (!applyOne(sid, stepColor)) return false
    }
    const present = colorsLocal.filter((c, i) => !triangles[i]?.deleted && c && c !== 'transparent')
    return new Set(present).size <= 1
  } catch {
    return false
  }
}

// 计算“高价值锚点池”：top hubs + hubs之间的过渡色块（邻接多个top hub）+ hubs邻居。
// 目的：起点不只盯最顶尖hub，也能选到“夹在高hub之间、对桥接至关重要”的区域。
function computeFocusAnchorIds(triangles, opts) {
  const topK = Number.isFinite(opts?.topK) ? Math.max(1, Math.floor(opts.topK)) : 18
  const betweenK = Number.isFinite(opts?.betweenK) ? Math.max(0, Math.floor(opts.betweenK)) : 10
  const neighborK = Number.isFinite(opts?.neighborK) ? Math.max(0, Math.floor(opts.neighborK)) : 10
  const pathK = Number.isFinite(opts?.pathK) ? Math.max(0, Math.floor(opts.pathK)) : 12
  const pathMaxDepth = Number.isFinite(opts?.pathMaxDepth) ? Math.max(2, Math.min(6, Math.floor(opts.pathMaxDepth))) : 4
  // “hub-connector”增强：识别像 52 这种内部枢纽（连接多个 hub-adjacent 同色块），以及其周围同色桥梁（如 48/49/56/57）
  const hubConnectorK = Number.isFinite(opts?.hubConnectorK) ? Math.max(0, Math.floor(opts.hubConnectorK)) : 14
  try {
    const stats = computeRegionStats(triangles)
    const arr = Array.isArray(stats?.regions) ? [...stats.regions] : []
    if (!arr.length) return []
    // 先按“基础桥接分”取 top hubs（避免两跳加成喧宾夺主导致 hub 定义漂移）
    arr.sort((a,b)=> (Number(b.scoreBase ?? b.score ?? 0)) - (Number(a.scoreBase ?? a.score ?? 0)))
    const top = arr.slice(0, topK)
    const topSet = new Set(top.map(r=>r.regionId))
    const regionIdToRep = new Map(arr.map(r=>[r.regionId, r.repId]))
    const adjMap = new Map(arr.map(r=>[r.regionId, Array.isArray(r.adjacentRegions) ? r.adjacentRegions : []]))

    // hubs 邻居：直接邻接 top hub 的色块也有高价值（作为桥接过渡）
    const neighborPool = []
    if (neighborK > 0) {
      for (const r of top) {
        for (const rid2 of (r.adjacentRegions || [])) {
          if (topSet.has(rid2)) continue
          neighborPool.push(rid2)
        }
      }
    }

    // hubs 之间的“内部桥梁”：在 region 图上找 top hubs 两两之间的短路径（<=pathMaxDepth），把中间节点加入候选。
    const pathPool = []
    if (pathK > 0 && top.length >= 2) {
      const hubRegionIds = top.slice(0, Math.min(6, top.length)).map(r=>r.regionId)
      const count = new Map() // regionId -> weight
      const bfsPath = (src, dst) => {
        const q = [src]
        const prev = new Map()
        prev.set(src, -1)
        let qi = 0
        while (qi < q.length) {
          const u = q[qi++]
          // 深度限制
          let du = 0
          let tmp = u
          while (tmp !== src && prev.has(tmp)) { du++; tmp = prev.get(tmp) }
          if (du > pathMaxDepth) continue
          if (u === dst) break
          for (const v of (adjMap.get(u) || [])) {
            if (prev.has(v)) continue
            prev.set(v, u)
            q.push(v)
          }
        }
        if (!prev.has(dst)) return null
        const path = []
        let cur = dst
        while (cur !== -1 && cur != null) {
          path.push(cur)
          cur = prev.get(cur)
        }
        path.reverse()
        return path
      }
      for (let i=0;i<hubRegionIds.length;i++){
        for (let j=i+1;j<hubRegionIds.length;j++){
          const a = hubRegionIds[i], b = hubRegionIds[j]
          const p = bfsPath(a,b)
          if (!p || p.length < 3) continue
          // 中间节点加权：越靠近中间越高（鼓励“从内部向外破局”）
          const mid = Math.floor(p.length/2)
          for (let k=1;k<p.length-1;k++){
            const rid = p[k]
            if (topSet.has(rid)) continue
            const w = 1 + Math.max(0, (mid - Math.abs(k-mid))) * 0.6
            count.set(rid, (count.get(rid)||0) + w)
          }
        }
      }
      const ranked = Array.from(count.entries()).map(([rid,w])=>({ rid, w })).sort((a,b)=>b.w-a.w)
      for (const it of ranked.slice(0, pathK)) pathPool.push(it.rid)
    }

    // hubs 之间：同时邻接 >=2 个 top hub 的色块（你说的“前几名之间的色块区域”）
    const betweenCandidates = []
    if (betweenK > 0) {
      for (const r of arr) {
        if (topSet.has(r.regionId)) continue
        const adj = Array.isArray(r.adjacentRegions) ? r.adjacentRegions : []
        let hit = 0
        for (const rid2 of adj) { if (topSet.has(rid2)) hit++ }
        if (hit >= 2) {
          betweenCandidates.push({ regionId: r.regionId, hit, score: Number(r.score||0) })
        }
      }
      betweenCandidates.sort((a,b)=> (b.hit - a.hit) || (b.score - a.score))
    }

    // hub-connector：两跳桥接结构
    // 目标：把“接壤高评分 hub 的同色小块”（hub-adjacent）与其共同邻居（connector）显式纳入候选，
    // 让求解更容易从内部突破，把多个 hub 串起来。
    const hubConnectorPool = []
    if (hubConnectorK > 0 && top.length >= 2) {
      const byRid = new Map(arr.map(r => [r.regionId, r]))
      // 对每个 region，记录它一跳触达的 hub 集合（只对非-hub 区域有意义）
      const hubAdj = new Set()
      const hubAdjToHubs = new Map() // rid -> Set(hubRid)
      for (const r of arr) {
        if (topSet.has(r.regionId)) continue
        const adj = Array.isArray(r.adjacentRegions) ? r.adjacentRegions : []
        const hubs1 = []
        for (const rid2 of adj) { if (topSet.has(rid2)) hubs1.push(rid2) }
        if (hubs1.length > 0) {
          hubAdj.add(r.regionId)
          hubAdjToHubs.set(r.regionId, new Set(hubs1))
        }
      }
      // 对每个候选 connector：看它邻居里哪些是 hubAdj；按“邻居颜色”分组
      // 若某个颜色组里 >=2 个 hubAdj，且它们触达的 hub 联合 >=2，则这是强“内部枢纽”
      const scored = []
      for (const c of arr) {
        const adj = Array.isArray(c.adjacentRegions) ? c.adjacentRegions : []
        if (adj.length < 2) continue
        const groups = new Map() // color -> rid[]
        for (const ridN of adj) {
          if (!hubAdj.has(ridN)) continue
          const rn = byRid.get(ridN)
          const col = rn?.color
          if (!col) continue
          const list = groups.get(col) || []
          list.push(ridN)
          groups.set(col, list)
        }
        if (groups.size === 0) continue
        let bestGroup = null
        let bestScore = -Infinity
        for (const [col, list] of groups.entries()) {
          if (!list || list.length < 2) continue
          const hubsUnion = new Set()
          for (const ridN of list) {
            const hs = hubAdjToHubs.get(ridN)
            if (hs) for (const h of hs) hubsUnion.add(h)
          }
          if (hubsUnion.size < 2) continue
          // 评分：越多 hub 被串联，越多同色桥梁围绕同一 connector，越优先
          // 轻微 tie-break：connector 自身的桥接 score（避免选到无意义边角）
          const s = (hubsUnion.size * 80) + (list.length * 18) + (Number(c.score||0) * 0.08)
          if (s > bestScore) {
            bestScore = s
            bestGroup = { color: col, members: list.slice(), hubsUnion: Array.from(hubsUnion) }
          }
        }
        if (bestGroup) {
          scored.push({
            connectorRid: c.regionId,
            connectorRep: c.repId,
            score: bestScore,
            members: bestGroup.members,
          })
        }
      }
      scored.sort((a,b)=> (b.score - a.score))
      for (const it of scored.slice(0, hubConnectorK)) {
        if (it.connectorRep != null) hubConnectorPool.push(it.connectorRep)
        // 同色桥梁成员也纳入（这些往往是“内部动手点”，比如 48/49/56/57）
        for (const ridN of (it.members || [])) {
          const rep = regionIdToRep.get(ridN)
          if (rep != null) hubConnectorPool.push(rep)
        }
      }
    }

    const out = []
    const add = (rid) => {
      const rep = regionIdToRep.get(rid)
      if (rep != null) out.push(rep)
    }
    for (const r of top) add(r.regionId)
    for (const rid of pathPool) add(rid)
    // hub-connector 优先级高：在“between/neighbor”之前注入，让 worker 更倾向内部破局
    for (const rep of hubConnectorPool) { if (rep != null) out.push(rep) }
    for (const b of betweenCandidates.slice(0, betweenK)) add(b.regionId)
    for (const rid of neighborPool.slice(0, neighborK)) add(rid)
    return Array.from(new Set(out))
  } catch {
    return []
  }
}

// 仅计算“内部桥梁锚点”：top hubs 两两之间短路径上的中间色块（越居中权重越高）
function computeInternalBridgeAnchorIds(triangles, opts) {
  const topK = Number.isFinite(opts?.topK) ? Math.max(2, Math.floor(opts.topK)) : 6
  const pathK = Number.isFinite(opts?.pathK) ? Math.max(0, Math.floor(opts.pathK)) : 14
  const pathMaxDepth = Number.isFinite(opts?.pathMaxDepth) ? Math.max(2, Math.min(6, Math.floor(opts.pathMaxDepth))) : 4
  try {
    const stats = computeRegionStats(triangles)
    const arr = Array.isArray(stats?.regions) ? [...stats.regions] : []
    if (!arr.length) return []
    arr.sort((a,b)=> (b.score||0) - (a.score||0))
    const top = arr.slice(0, topK)
    if (top.length < 2) return []
    const regionIdToRep = new Map(arr.map(r=>[r.regionId, r.repId]))
    const adjMap = new Map(arr.map(r=>[r.regionId, Array.isArray(r.adjacentRegions) ? r.adjacentRegions : []]))
    const hubRegionIds = top.map(r=>r.regionId)
    const count = new Map()
    const bfsPath = (src, dst) => {
      const q = [src]
      const prev = new Map()
      prev.set(src, -1)
      let qi = 0
      while (qi < q.length) {
        const u = q[qi++]
        // depth bound (reconstruct depth cheaply)
        let du = 0
        let tmp = u
        while (tmp !== src && prev.has(tmp)) { du++; tmp = prev.get(tmp) }
        if (du > pathMaxDepth) continue
        if (u === dst) break
        for (const v of (adjMap.get(u) || [])) {
          if (prev.has(v)) continue
          prev.set(v, u)
          q.push(v)
        }
      }
      if (!prev.has(dst)) return null
      const path = []
      let cur = dst
      while (cur !== -1 && cur != null) { path.push(cur); cur = prev.get(cur) }
      path.reverse()
      return path
    }
    for (let i=0;i<hubRegionIds.length;i++){
      for (let j=i+1;j<hubRegionIds.length;j++){
        const a = hubRegionIds[i], b = hubRegionIds[j]
        const p = bfsPath(a,b)
        if (!p || p.length < 3) continue
        const mid = Math.floor(p.length/2)
        for (let k=1;k<p.length-1;k++){
          const rid = p[k]
          const w = 1 + Math.max(0, (mid - Math.abs(k-mid))) * 0.8
          count.set(rid, (count.get(rid)||0) + w)
        }
      }
    }
    const ranked = Array.from(count.entries()).map(([rid,w])=>({ rid, w })).sort((a,b)=>b.w-a.w)
    const out = []
    for (const it of ranked.slice(0, pathK)) {
      const rep = regionIdToRep.get(it.rid)
      if (rep != null) out.push(rep)
    }
    return Array.from(new Set(out))
  } catch {
    return []
  }
}

// 仅计算“真实 top hubs”：只取桥接评分最高的一批色块代表点，作为 worker 的 hub 目标集合（用于奖励/惩罚/内部破局判定）。
function computeHubAnchorIds(triangles, opts) {
  const topK = Number.isFinite(opts?.topK) ? Math.max(2, Math.floor(opts.topK)) : 6
  try {
    const stats = computeRegionStats(triangles)
    const arr = Array.isArray(stats?.regions) ? [...stats.regions] : []
    if (!arr.length) return []
    // “真实 hubs”只看基础桥接分，防止两跳加成把 connector 误抬为 hub
    arr.sort((a,b)=> (Number(b.scoreBase ?? b.score ?? 0)) - (Number(a.scoreBase ?? a.score ?? 0)))
    const out = []
    for (const r of arr.slice(0, topK)) {
      if (r?.repId != null) out.push(r.repId)
    }
    return Array.from(new Set(out))
  } catch {
    return []
  }
}

// 两跳候选列表：只看“两跳分”，不看总分/一跳分。
// 定义：优先选择 connector（两步可串联多个高评分 hub）及其同色桥梁成员；
// 返回按两跳分排序的 repId 列表（用于并行 A 组线程分工）。
function computeInternalTwoHopIds(triangles, opts) {
  const hubsK = Number.isFinite(opts?.hubsK) ? Math.max(2, Math.floor(opts.hubsK)) : 6
  const topK = Number.isFinite(opts?.topK) ? Math.max(1, Math.floor(opts.topK)) : 6
  try {
    const stats = computeRegionStats(triangles)
    const arr = Array.isArray(stats?.regions) ? [...stats.regions] : []
    if (!arr.length) return []
    // hubs 只按基础分定义（避免两跳加成喧宾夺主）
    const hubs = [...arr].sort((a,b)=> Number(b.scoreBase ?? b.score ?? 0) - Number(a.scoreBase ?? a.score ?? 0)).slice(0, hubsK)
    const hubSet = new Set(hubs.map(h=>h.regionId))
    const scored = []
    for (const r of arr) {
      if (r?.repId == null) continue
      if (hubSet.has(r.regionId) || r.isHub) continue // 内部线程不盯 hub 本体
      // 两跳分：只由 connector 串联强度驱动（hub 权重覆盖 + 同色桥数量）
      // connector：直接用 connectorHubWeight/Count/MemberCount
      // member：用 memberConnectorHubWeight/Count/MemberCount（由 computeRegionStats 记录其所属 connector 的两跳强度）
      let w = 0
      let c = 0
      let m = 0
      if (r.isConnector) {
        w = Number(r.connectorHubWeight || 0)
        c = Number(r.connectorHubCount || 0)
        m = Number(r.connectorMemberCount || 0)
      } else if (r.isConnectorMember) {
        w = Number(r.memberConnectorHubWeight || 0)
        c = Number(r.memberConnectorHubCount || 0)
        m = Number(r.memberConnectorMemberCount || 0)
      } else {
        continue
      }
      const twoHop = (w * 120) + (c * 40) + (m * 18)
      if (twoHop > 0) scored.push({ repId: r.repId, score: twoHop })
    }
    scored.sort((a,b)=> b.score - a.score)
    return Array.from(new Set(scored.slice(0, topK).map(x=>x.repId)))
  } catch {
    return []
  }
}

// 设置默认的求解器开关与权重，并合并本地持久化配置（localStorage）
if (typeof window !== 'undefined') {
  let persisted = null
  try { persisted = JSON.parse(localStorage.getItem('solverFlags') || 'null') } catch {}
  // 根据环境推断后端地址：开发用 localhost:3001，生产同域
  let serverBaseDefault = 'http://localhost:3001'
  try {
    const isLocal = String(window.location.hostname||'').toLowerCase() === 'localhost'
    serverBaseDefault = isLocal ? 'http://localhost:3001' : (window.location.origin || '')
  } catch {}
  // 默认初始配置：与性能调节窗口一致，开箱即用
  window.SOLVER_FLAGS = {
    // 基本搜索策略（更偏向“尽快拿到可行解”）
    enableLB: true,
    enableLookahead: true,
    enableLookaheadDepth2: true,
    enableIncremental: true,
    enableBeam: true,
    beamWidth: 32,
    // 动态束宽参数
    beamDecay: 0.85,
    beamMin: 8,
    enableBestFirst: true,
    // Best-First 行为细化
    useAStarInBestFirst: true,
    useStrongLBInBestFirst: false,
    enableBridgeFirst: true,
    enableZeroExpandFilter: true,
    // 快速拿到候选解
    useDFSFirst: true,
    returnFirstFeasible: true,
    // 严格模式（A* 最短路）
    // 注意：并行模式下我们会把“严格模式”默认分配给少量线程（1-2个）长期跑，不会让所有线程都进入 strict IDA*
    strictMode: true,
    logPerf: true,
    // 学习优先级与 SAT 宏规划
    enableLearningPrioritizer: true,
    enableSATPlanner: true,
    // 分块与宏规划（试验性）：默认开启，便于观察宏顺序日志并提高命中率
    enableRAGMacro: true,
    // 严格模式增强：默认启用 IDA* + TT min-f 复用
    useIDAStar: true,
    enableTTMinFReuse: true,
    // 默认启发式：若已加载 pdb_6x6，则严格线程会自动切到 PDB；否则仍可回退到 dynamic_rag_max
    heuristicName: 'pdb6x6_max',
    // 后端遥测开关与服务地址
    enableTelemetry: true,
    serverBaseUrl: serverBaseDefault,
    // 进度与时间预算
    workerTimeBudgetMs: 300000,
    // 默认并行线程：按用户要求，直接最强 24（会按硬件核心数保护，除非开启“超核”）
    parallelWorkers: 24,
    // 默认开启超核（用户要求最强 24 线程并行）；若浏览器卡顿可在性能面板关闭
    parallelOvercommit: true,
    preprocessTimeBudgetMs: 20000,
    progressComponentsIntervalMs: 0,
    progressDFSIntervalMs: 100,
    // A* 阶段进度节流
    progressAStarIntervalMs: 80,
    // 权重参数（强调连通与桥接，避免面积偏好）
    adjAfterWeight: 0.6,
    bridgeWeight: 1.3,
    gateWeight: 0.6,
    richnessWeight: 0.5,
    boundaryWeight: 0.8,
    regionClassWeights: { boundary: 0.9, bridge: 1.4, richness: 0.6, saddle: 1.0 },
    dimensionWeights: { expand: 1.2, connect: 1.5, barrier: 0.8, multiFront: 2.0 },
    bifrontWeight: 2.0,
    // 稀有颜色与扩张过滤（更宽松）
    rareFreqRatio: 0.03,
    rareFreqAbs: 3,
    rareAllowBridgeMin: 2.0,
    rareAllowGateMin: 1.0,
    minDeltaRatio: 0.02,
    lbImproveMin: 1,
    // 路径优化
    optimizeWindowSize: 6,
    optimizeEnableWindow: true,
    optimizeEnableRemoval: true,
    optimizeSwapPasses: 2,
    // 默认加载 PDB（通过代码控制）：开启后在启动时尝试加载默认 PDB
    // 来源优先级：远程（pdbBaseUrl） > window.__PDB_AUTOLOAD__[key] > localStorage('PDB:'+key)
    enablePDBAutoLoad: true,
    // PDB 基础 URL（可通过面板或 env/window 覆写）：默认 '/pdb/'
    pdbBaseUrl: '/pdb/',
    // 合并已有与持久化设置，持久化优先生效
    ...(window.SOLVER_FLAGS || {}),
    ...(persisted || {}),
  }
  // 用户要求：默认并行线程升到 24。为避免旧 localStorage（如 3）残留，这里强制覆盖并写回。
  try { window.SOLVER_FLAGS.parallelWorkers = 24 } catch {}
  try { if (window.SOLVER_FLAGS.parallelOvercommit == null) window.SOLVER_FLAGS.parallelOvercommit = true } catch {}
  // 强制开启遥测：不受持久化配置影响，确保自动上传策略与学习统计
  try {
    window.SOLVER_FLAGS.enableTelemetry = true
    // 用户要求：把圈选的高收益开关作为默认项（如本地旧配置缺失/过旧，则迁移到新默认）
    const DEFAULT_PRESET_VER = 1
    const pv = Number(persisted?.__presetVersion || 0)
    const needPresetUpgrade = !(pv >= DEFAULT_PRESET_VER)
    if (needPresetUpgrade) {
      try {
        window.SOLVER_FLAGS.enableLookaheadDepth2 = true
        window.SOLVER_FLAGS.strictMode = true
        window.SOLVER_FLAGS.useIDAStar = true
        window.SOLVER_FLAGS.enableTTMinFReuse = true
        window.SOLVER_FLAGS.enableSATPlanner = true
        window.SOLVER_FLAGS.enableRAGMacro = true
        window.SOLVER_FLAGS.enablePDBAutoLoad = true
        if (!window.SOLVER_FLAGS.pdbBaseUrl) window.SOLVER_FLAGS.pdbBaseUrl = '/pdb/'
        window.SOLVER_FLAGS.heuristicName = window.SOLVER_FLAGS.heuristicName || 'pdb6x6_max'
      } catch {}
    }
    // 强制写回默认并行线程，避免面板/后续会话仍显示旧值（例如 3）
    try { window.SOLVER_FLAGS.parallelWorkers = 24 } catch {}
    try { if (window.SOLVER_FLAGS.parallelOvercommit == null) window.SOLVER_FLAGS.parallelOvercommit = true } catch {}
    // 写回本地，避免旧配置残留导致后续会话关闭遥测
    const persistedNext = {
      ...(persisted||{}),
      enableTelemetry: true,
      ...(needPresetUpgrade ? {
        __presetVersion: DEFAULT_PRESET_VER,
        enableLookaheadDepth2: true,
        strictMode: true,
        useIDAStar: true,
        enableTTMinFReuse: true,
        enableSATPlanner: true,
        enableRAGMacro: true,
        enablePDBAutoLoad: true,
        pdbBaseUrl: '/pdb/',
        heuristicName: (persisted||{}).heuristicName || 'pdb6x6_max',
      } : {}),
    }
    localStorage.setItem('solverFlags', JSON.stringify({ ...window.SOLVER_FLAGS, ...persistedNext }))
  } catch {}
  // 启动时根据开关尝试默认加载 PDB（仅一次），优先远程
  try {
    if (window.SOLVER_FLAGS?.enablePDBAutoLoad) {
      const key = 'pdb_6x6'
      if (!hasPDB(key)) {
        (async () => {
          let loaded = false
          try {
            const base = getPDBBaseURL()
            const url = `${base}${key}.json`
            loaded = await loadPDBFromURL(key, url)
            if (loaded) {
              console.info(`[PDB] 已自动加载（远程）：${key} <- ${url}`)
            }
          } catch {}
          if (!loaded) {
            const sourceObj = (typeof window !== 'undefined' && window.__PDB_AUTOLOAD__ && window.__PDB_AUTOLOAD__[key]) ? window.__PDB_AUTOLOAD__[key] : null
            const lsJson = localStorage?.getItem('PDB:' + key)
            if (sourceObj && typeof sourceObj === 'object') {
              loaded = !!loadPDBObject(key, sourceObj)
            } else if (lsJson) {
              loaded = !!loadPDBFromJSON(key, lsJson)
            }
            console.info(loaded ? `[PDB] 已自动加载（本地来源）：${key}` : `[PDB] 自动加载未找到数据：${key}`)
          }
        })()
      }
    }
  } catch (e) {
    console.warn('[PDB] 自动加载异常：', e)
  }
}
attachSolverToWindow()

// 辅助：正数取模
const pMod = (a, n) => (a % n + n) % n

function App() {
  // 避免每次渲染都刷屏：只在首次挂载时打印一次（调试用）
  useEffect(() => {
    try { console.log('App mounted') } catch {}
  }, [])
  // 简易哈希路由：用于“说明”子页
  const [route, setRoute] = useState(() => (typeof window!=='undefined' ? window.location.hash : ''))
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  // 总站访问控制：令牌登录（会话/持久化）
  const [hubAuthed, setHubAuthed] = useState(() => {
    try {
      const token = localStorage.getItem('adminToken')
      if (token && token.length>0) return true
      return sessionStorage.getItem('hubAuthed') === '1'
    } catch { return false }
  })
  const [hubPwd, setHubPwd] = useState('')
  const [imgBitmap, setImgBitmap] = useState(null)
  const [palette, setPalette] = useState([])
  const [grid, setGrid] = useState(null)
  const [triangles, setTriangles] = useState([])
  const [selectedColor, setSelectedColor] = useState(null)
const [triangleSize, setTriangleSize] = useState(30)
  const [startId, setStartId] = useState(null)
  const [selectedIds, setSelectedIds] = useState([])
  const [undoStack, setUndoStack] = useState([])
  const [redoStack, setRedoStack] = useState([])
  // 统一的操作历史（限制最近5步）
  const [historyStack, setHistoryStack] = useState([])
  const [historyRedoStack, setHistoryRedoStack] = useState([])
  // 初始状态快照（用于“重做=重置到初始状态”）
  const [initialPalette, setInitialPalette] = useState([])
  const [initialSelectedColor, setInitialSelectedColor] = useState(null)
  const [initialDeletedIds, setInitialDeletedIds] = useState([])
  const [steps, setSteps] = useState([])
  const [bestStartId, setBestStartId] = useState(null)
  const [status, setStatus] = useState('请上传图片')
  const [editMode, setEditMode] = useState(true)
  // 色块统计（region stats）
  const [regionStats, setRegionStats] = useState(null)
  const [regionStatsPng, setRegionStatsPng] = useState(null)
  const [regionStatsReady, setRegionStatsReady] = useState(false)
  const [regionStatsComputing, setRegionStatsComputing] = useState(false)
  const [showRegionStats, setShowRegionStats] = useState(false)
  const [regionCountLive, setRegionCountLive] = useState(null)
  const [rotation, setRotation] = useState(0)
  // 网格排列方向：horizontal（底边水平）/ vertical（底边竖直）
  const [gridArrangement, setGridArrangement] = useState('vertical')
  // 网格偏移量 (自动对齐用)
  const [gridOffsetX, setGridOffsetX] = useState(0)
  const [gridOffsetY, setGridOffsetY] = useState(0)
  // 检测到的网格规格
  const [detectedGrid, setDetectedGrid] = useState(null)
  // 画布显示缩放（仅影响展示尺寸）
  const [canvasScale, setCanvasScale] = useState(1)
  const canvasWrapRef = useRef(null)
  
  // 使用 Ref 追踪最新的 scale，解决闭包过期问题
  const scaleRef = useRef(canvasScale)
  // 用于在缩放后恢复锚点的 Ref
  const pendingScrollRef = useRef(null)

  useEffect(() => { scaleRef.current = canvasScale }, [canvasScale])
  
  const touchRef = useRef({ lastDist: 0, startScale: 1, isPinching: false })
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      const t1 = e.touches[0]
      const t2 = e.touches[1]
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)
      touchRef.current.lastDist = dist
      touchRef.current.startScale = scaleRef.current
      touchRef.current.isPinching = true
    }
  }, [])

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && touchRef.current.isPinching) {
      e.preventDefault() // 阻止浏览器缩放
      const t1 = e.touches[0]
      const t2 = e.touches[1]
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY)
      const scale = touchRef.current.startScale * (dist / touchRef.current.lastDist)
      const clamped = Math.min(5, Math.max(0.1, scale))
      setCanvasScale(clamped)
    }
  }, [])

  const handleTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) {
      touchRef.current.isPinching = false
    }
  }, [])

  // 监听缩放变化，应用锚定滚动位置
  useEffect(() => {
    if (pendingScrollRef.current && canvasWrapRef.current) {
      const { left, top } = pendingScrollRef.current
      canvasWrapRef.current.scrollLeft = left
      canvasWrapRef.current.scrollTop = top
      pendingScrollRef.current = null
    }
  }, [canvasScale])

  const [solving, setSolving] = useState(false)
  // 自动求解步数上限（用于剪枝与性能控制），持久化到 localStorage；允许为空表示不限制
  const [maxStepsLimit, setMaxStepsLimit] = useState(() => {
    try {
      const raw = localStorage.getItem('maxStepsLimit')
      if (raw == null || raw === '') return null
      const v = parseInt(raw, 10)
      return Number.isFinite(v) ? Math.max(1, Math.min(200, v)) : null
    } catch { return null }
  })
  useEffect(() => {
    try {
      if (maxStepsLimit == null) {
        localStorage.removeItem('maxStepsLimit')
      } else {
        localStorage.setItem('maxStepsLimit', String(maxStepsLimit))
      }
    } catch {}
  }, [maxStepsLimit])
  // 框选状态
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState(null)
  const [dragRect, setDragRect] = useState(null)
  // 套索选择状态
  const [lassoPath, setLassoPath] = useState([])
  const [lassoClosed, setLassoClosed] = useState(false)
  const LASSO_MIN_DIST = 4
  const LASSO_CLOSE_RADIUS = 12
  const LASSO_SAMPLE_COUNT = 20
  const LASSO_THRESHOLD = 0.5
  // 工程加载标记：用于避免导入后被副作用重建覆盖
  const [loadedProject, setLoadedProject] = useState(false)
  // 颜色分离强度（影响灰色惩罚与暖色回退边界）
  const [colorSeparation, setColorSeparation] = useState(4)
  // 取色模式：点击画布拾取颜色并加入调色板
  const [pickMode, setPickMode] = useState(false)
  // 导入选项：仅加载画布用色（忽略快照中的 palette）
  const [importPaletteOnlyFromTriangles, setImportPaletteOnlyFromTriangles] = useState(false)
  // 目标颜色数量（用户强制指定）
  const [targetColorCount, setTargetColorCount] = useState('')
  // AI 智能校准状态
  const [isAiProcessing, setIsAiProcessing] = useState(false)
  const [aiSegmentationMap, setAiSegmentationMap] = useState(null)

  // 监听 targetColorCount 变化，实时重新识别
  useEffect(() => {
    if (imgBitmap && targetColorCount !== '') {
      let cancelled = false
      const tc = parseInt(targetColorCount)
      if (!Number.isFinite(tc) || tc < 2) return
      const timer = setTimeout(() => {
        ;(async () => {
          try {
            setStatus(`正在重新识别为 ${tc} 种颜色...`)
            const { palette } = await quantizeImage(imgBitmap, tc)
            if (cancelled) return
            setPalette(palette)
            setInitialPalette(palette)
            if (grid) {
              const mapped = await mapImageToGrid(imgBitmap, grid, palette)
              if (cancelled) return
              // 若存在检测到的网格参数，额外做一次“同格子多数投票”收尾校准（减少残留错色）
              try { if (detectedGrid && detectedGrid.success) rectifyColorsByGrid(mapped, detectedGrid) } catch {}
              setTriangles(mapped)
              setUndoStack([mapped.map(t => t.color)])
              setRedoStack([])
              setStartId(null)
              setSelectedIds([])
              setSteps([])
              setStatus(`已重新生成（强制 ${palette.length} 色）`)
            }
          } catch (e) {
            if (cancelled) return
            setStatus(`强制颜色数识别失败：${String(e?.message || e).slice(0, 120)}`)
          }
        })()
      }, 220)
      return () => { cancelled = true; try { clearTimeout(timer) } catch {} }
    }
  }, [targetColorCount, imgBitmap, grid, detectedGrid])

  // 点击“添加颜色”始终进入色带选择；选择后由 onAddColorFromPicker 进行泼涂或加入集合
  const onStartAddColorPick = useCallback(() => {
    setPickMode(true)
    setStatus('添加颜色模式：点击彩虹色带选择颜色')
  }, [])
  const onAddColorFromPicker = useCallback((hex) => {
    const prevSelected = selectedColor
    // 仅添加到颜色集合，不进行泼涂
    setPalette(p => {
      const next = p.includes(hex) ? p : [...p, hex]
      localStorage.setItem('palette', JSON.stringify(next))
      return next
    })
    setSelectedColor(hex)
    setStatus(`已添加颜色：${hex}`)
    setPickMode(false)
    // 记录历史，支持撤销/重做，限制最近5步
    setHistoryStack(prev => {
      const next = [...prev, { type: 'palette_add', color: hex, prevSelectedColor: prevSelected }]
      return next.length > 5 ? next.slice(next.length - 5) : next
    })
    setHistoryRedoStack([])
  }, [selectedColor])
  const onCancelPick = useCallback(() => { setPickMode(false); setStatus('已取消添加颜色') }, [])
  // 清理调色板：仅保留当前画布出现的颜色（按出现频次降序）
  const onCleanPaletteToCanvasColors = useCallback(() => {
    if (!triangles || triangles.length===0) { setStatus('当前画布为空，无法清理调色板'); return }
    const freq = colorFrequency(triangles)
    const next = [...freq.keys()].sort((a,b)=> (freq.get(b)||0) - (freq.get(a)||0))
    setPalette(next)
    try { localStorage.setItem('palette', JSON.stringify(next)) } catch {}
    setSelectedColor(prev => next.includes(prev) ? prev : (next[0] ?? null))
    setStatus(`已清理调色板（保留画布用色，共 ${next.length} 色）`)
  }, [triangles])

  // 独立的后台 AI 分析逻辑
  const runBackgroundAiAnalysis = useCallback(async (bitmap, currentGrid, currentPalette, currentTriangles) => {
    if (!bitmap || !currentGrid || !currentTriangles || currentTriangles.length === 0) return
    if (isAiProcessing) return

    setIsAiProcessing(true)
    // 静默状态更新，不干扰用户主流程
    // setStatus('后台 AI 分析中...') 
    
    try {
      // 1. 离屏 Canvas 准备
      const maxDim = 512
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
      const w = Math.round(bitmap.width * scale)
      const h = Math.round(bitmap.height * scale)
      
      const offCanvas = document.createElement('canvas')
      offCanvas.width = w
      offCanvas.height = h
      const ctx = offCanvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0, w, h)
      
      const blob = await new Promise(resolve => offCanvas.toBlob(resolve, 'image/jpeg', 0.9))
      const url = URL.createObjectURL(blob)
      
      // 2. 生成 Prompts
      const prompts = []
      const colorMap = new Map()
      currentTriangles.forEach(t => {
        if (t.deleted || t.color === 'transparent') return
        if (!colorMap.has(t.color)) colorMap.set(t.color, [])
        colorMap.get(t.color).push(t)
      })
      
      // 重新实现 Prompt 生成逻辑 (复用 onAiRectify 的核心代码，但更健壮)
      const idToIndex = new Map(currentTriangles.map((t, i) => [t.id, i]))
      
      colorMap.forEach((tris, color) => {
        const visited = new Set()
        for (const t of tris) {
          if (visited.has(t.id)) continue
          const component = []
          const q = [t]
          visited.add(t.id)
          component.push(t)
          let head = 0
          while(head < q.length) {
            const curr = q[head++]
            for (const nid of curr.neighbors) {
              const idx = idToIndex.get(nid)
              if (idx !== undefined) {
                const neighbor = currentTriangles[idx]
                if (!visited.has(neighbor.id) && neighbor.color === color && !neighbor.deleted) {
                  visited.add(neighbor.id)
                  component.push(neighbor)
                  q.push(neighbor)
                }
              }
            }
          }
          if (component.length > 5) {
             let sumX = 0, sumY = 0
             component.forEach(c => { sumX += c.centroid.x; sumY += c.centroid.y })
             prompts.push({ x: (sumX/component.length)*scale, y: (sumY/component.length)*scale, label: 1, color })
          }
        }
      })
      
      if (prompts.length === 0) prompts.push({ x: w/2, y: h/2, label: 1, color: currentPalette[0] || '#000000' })

      // 3. 调用 本地几何引擎
      const output = await AIService.segmentImageWithPoints(url, prompts)
      URL.revokeObjectURL(url)
      
      // 4. 保存结果，准备校准
      setAiSegmentationMap({ ...output, aiScale: scale, originalSize: { width: w, height: h } })
      setStatus(`几何分析已就绪。点击“几何校准”以复核纠正。`)
      
    } catch (e) {
      console.error('Local Analysis Error:', e)
      setStatus('几何分析失败，请手动校准')
    } finally {
      setIsAiProcessing(false)
    }
  }, [isAiProcessing])

  // 执行 几何校准 (应用已有的分析结果)
  const onAiRectify = useCallback(async () => {
    if (!imgBitmap || !grid) { setStatus('请先上传图片'); return }
    
    // 如果后台分析还没跑或者失败了，尝试现场跑一次
    if (!aiSegmentationMap) {
        if (!isAiProcessing) {
            setStatus('正在启动几何分析...')
            await runBackgroundAiAnalysis(imgBitmap, grid, palette, triangles)
            return 
        } else {
            setStatus('几何引擎正在分析中，请稍候...')
            return
        }
    }

    setStatus('正在应用几何校准...')
    
    try {
      // 强力纠正模式：传入 aiSegmentationMap
      const mapped = await mapImageToGrid(imgBitmap, grid, palette, { 
          aiSegmentation: aiSegmentationMap, 
          aiScale: aiSegmentationMap.aiScale,
          rectifyMode: true, // 新增标志，指示这是强力纠正
          applyDenoise: false // 禁止同化逻辑，确保涂色不被“平滑”掉
      })
      // 若我们有网格检测信息（anchors/spacing/angles），则做一次“同格子多数投票”的收尾校准
      // 这能修复少量残留错色（通常是边界/压缩噪点导致的单点误判）
      try {
        if (detectedGrid && detectedGrid.success) {
          const changed = rectifyColorsByGrid(mapped, detectedGrid)
          if (changed) {
            // 不打扰用户，只在状态里轻提示
            setStatus('几何校准已完成：已根据色块边界优化网格，并修复残留错色。')
          }
        }
      } catch {}
      
      setTriangles(mapped)
      setUndoStack(prev => [...prev, mapped.map(t => t.color)])
      // 若上面的“残留错色修复”已更新 status，这里不要覆盖
      setStatus(prev => (String(prev||'').includes('残留错色') ? prev : '几何校准已完成：已根据色块边界优化网格。'))
      
    } catch (err) {
      console.error('Rectify Apply Error:', err)
      setStatus(`应用校准失败: ${err.message}`)
    }
  }, [imgBitmap, grid, palette, triangles, aiSegmentationMap, isAiProcessing, runBackgroundAiAnalysis, detectedGrid])

  // 辅助函数：计算 Mask 的边界框
  const getMaskBBox = (data, w, h) => {
    let minX = w, minY = h, maxX = 0, maxY = 0
    let hasFg = false
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[y * w + x] > 0) {
          hasFg = true
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    return hasFg ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null
  }

  // 导出 AI 调试数据
  const onExportAiDebug = useCallback(async () => {
    if (!aiSegmentationMap || !imgBitmap) { setStatus('无可用 AI 数据'); return }
    
    setStatus('正在生成 AI 调试报告...')
    
    // 1. 导出 JSON 数据（Prompts & Meta）
      const debugData = {
        aiScale: aiSegmentationMap.aiScale,
        originalSize: aiSegmentationMap.originalSize,
        errors: aiSegmentationMap.errors || [],
        // 新增：提取所有多边形顶点（Approximate Polygons）
        // 为了方便查看，我们对 maskRaw 进行简单的轮廓提取（Marching Squares 或 简单遍历）
        // 这里为了简化，我们只导出 mask 的边界框和中心点，以及原始 Prompt 点
        results: aiSegmentationMap.results.map((r, i) => ({
          id: i,
          color: r.point?.color,
          point: r.point, // 提示点坐标（原始图像空间）
          score: r.score,
          maskInfo: r.maskRaw ? {
            width: r.maskRaw.width,
            height: r.maskRaw.height,
            // 简单计算边界框
            bbox: getMaskBBox(r.maskRaw.data, r.maskRaw.width, r.maskRaw.height)
          } : null
        }))
      }
    
    try {
      const jsonBlob = new Blob([JSON.stringify(debugData, null, 2)], { type: 'application/json' })
      const jsonUrl = URL.createObjectURL(jsonBlob)
      const a1 = document.createElement('a')
      a1.href = jsonUrl
      a1.download = `ai-debug-meta-${Date.now()}.json`
      a1.click()
      URL.revokeObjectURL(jsonUrl)
      
      // 2. 导出可视化图像 (Masks Overlay)
      const dataUrl = await generateAiDebugImage(imgBitmap, aiSegmentationMap)
      if (dataUrl) {
        const a2 = document.createElement('a')
        a2.href = dataUrl
        a2.download = `ai-debug-viz-${Date.now()}.png`
        a2.click()
      }
      
      setStatus('已导出 AI 分析数据（请查看下载的 JSON 和 PNG）')
    } catch (e) {
      console.error('Export AI Debug Failed:', e)
      setStatus('导出 AI 数据失败')
    }
  }, [aiSegmentationMap, imgBitmap])

  // 导出网格线调试图 (纯网格线条 PNG)
  const onExportGridDebug = useCallback(() => {
    if (!detectedGrid || !detectedGrid.gridLines || !imgBitmap) { setStatus('无可用网格线数据'); return }
    
    try {
      const dataUrl = exportGridOverlay(imgBitmap.width, imgBitmap.height, detectedGrid.gridLines, detectedGrid.bounds)
      if (dataUrl) {
        const a = document.createElement('a')
        a.href = dataUrl
        a.download = `grid-debug-overlay-${Date.now()}.png`
        a.click()
        setStatus('已导出网格线调试图')
      }
    } catch (e) {
      console.error('Export Grid Debug Failed:', e)
      setStatus('导出网格调试图失败')
    }
  }, [detectedGrid, imgBitmap])


  // 自动求解进度（显示实时状态）
  const [solveProgress, setSolveProgress] = useState(null)
  // 实时滚动小窗口：进度日志
  const [progressLogs, setProgressLogs] = useState([])
  // 让“合格解日志落盘”拿到最新的 progressLogs（避免闭包陈旧）
  const progressLogsRef = useRef([])
  useEffect(() => { progressLogsRef.current = progressLogs }, [progressLogs])

  // 合格解日志：独立存储，不随“清除解缓存”删除
  const [showSolveLogModal, setShowSolveLogModal] = useState(false)
  const [qualifiedLogs, setQualifiedLogs] = useState([])
  const [selectedQualifiedLog, setSelectedQualifiedLog] = useState(null)

  const canvasRef = useRef(null)
  const progressLastRef = useRef(0)
  const solveStartRef = useRef(0)
const contribRef = useRef({ branch_pruned: 0, enqueued: 0, expanded: 0, critical_hits: 0, path_len_reduction: 0, lb_improve_total: 0 })
  const progressLogRef = useRef(null)
  const importRef = useRef(null)
  const rebuildTimerRef = useRef(null)

  // 将当前画布数据暴露到 window，便于性能调节面板进行基准测试
  useEffect(() => {
    try {
      const lightTris = Array.isArray(triangles) ? triangles.map(t=>({ id:t.id, neighbors:t.neighbors, color:t.color, deleted:!!t.deleted })) : []
      window.__CURRENT_TRIANGLES__ = lightTris
      window.__CURRENT_PALETTE__ = Array.isArray(palette) ? [...palette] : []
      // 计算并缓存最新签名，供总站页在未装载画布时回退读取
      try {
        const sig = makeGraphSignature(lightTris, Array.isArray(palette) ? [...palette] : [])
        window.__LAST_SIG__ = sig
        localStorage.setItem('lastSignature', sig)
      } catch {}
    } catch {}
  }, [triangles, palette])

  // 居中视图（不改变缩放，仅设置偏移）
  const centerView = useCallback(() => {
    try {
      const wrap = canvasWrapRef.current
      if (!wrap || !grid) return
      
      const swap = rotation === 90 || rotation === 270
      const cw = (swap ? grid.height : grid.width) * canvasScale
      const ch = (swap ? grid.width : grid.height) * canvasScale
      const ww = wrap.clientWidth
      const wh = wrap.clientHeight
      
      if (cw > ww) wrap.scrollLeft = (cw - ww) / 2
      if (ch > wh) wrap.scrollTop = (ch - wh) / 2
    } catch {}
  }, [grid, rotation, canvasScale])

  // 初次加载时展示占位网格，避免空白画布
  useEffect(() => {
    if (imgBitmap || grid) return
    const wrap = canvasWrapRef.current
    const w = wrap?.clientWidth || 1600
    const h = wrap?.clientHeight || 1200
    const sideInit = triangleSize
    const g = (gridArrangement === 'horizontal')
      ? buildTriangleGrid(w, h, sideInit, gridOffsetX, gridOffsetY)
      : buildTriangleGridVertical(w, h, sideInit, gridOffsetX, gridOffsetY)
    setGrid(g)
    const tris = g.triangles.map(t => ({ ...t, color: (t.up ?? t.left) ? '#1b2333' : '#121826' }))
    setTriangles(tris)
  }, [imgBitmap, gridArrangement, triangleSize])

  // 用于存储检测到的精确网格参数（绕过 UI 整数限制）
  const [preciseGridParams, setPreciseGridParams] = useState(null)

  const handleImage = useCallback(async (e) => {
    // 兼容 input event 和直接传入 blob
    const file = e.target?.files ? e.target.files[0] : e
    if (!file) return

    // 重置所有状态
    setStatus('正在分析图片...')
    setSteps([])
    setStartId(null)
    setBestStartId(null)
    setGrid(null)
    setTriangles([])
    setUndoStack([])
    setRedoStack([])
    setHistoryStack([])
    setHistoryRedoStack([])
    setLassoPath([])
    setLassoClosed(false)
    setAiSegmentationMap(null)
    setDetectedGrid(null)
    setPreciseGridParams(null)
    // 重置对齐参数
    setGridOffsetX(0)
    setGridOffsetY(0)
    
    // 尊重 EXIF 方向，确保宽高与物理图像一致，避免比例失真
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    setImgBitmap(bitmap)
    
    // 不重置用户的“强制颜色数”：上传新图片也应尊重当前输入
    setLoadedProject(false)

    // 初次识别：若用户指定了强制颜色数，则直接按该数量量化
    const tc0 = parseInt(targetColorCount)
    const { palette } = await quantizeImage(bitmap, (Number.isFinite(tc0) && tc0 >= 2) ? tc0 : undefined)
    setPalette(palette)
    setInitialPalette(palette)
    setSelectedColor(palette[0] ?? null)
    setInitialSelectedColor(palette[0] ?? null)

    const w = bitmap.width
    const h = bitmap.height
    // 自动微调三角形尺寸：当使用默认值时，根据图像短边计算，使列/行数更合理，比例更稳定
    let sideBase = triangleSize
    const DEFAULT_SIDE = 18
    if (triangleSize === DEFAULT_SIDE) {
      const short = Math.min(w, h)
      // 目标：短边约 90 个半边间距（更细密，减少形状“变形”感）
      const targetAcrossShort = 90
      // 放宽自适应范围：6~60
      sideBase = Math.max(6, Math.min(60, Math.round((2 * short) / targetAcrossShort)))
    }
    const side = sideBase
    
    // 1. 尝试检测网格
    let autoGrid = null
    let autoOffsetX = 0
    let autoOffsetY = 0
    let finalSide = side
    let finalArrangement = gridArrangement

    try {
      // 提取 ImageData 用于检测
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      const imageData = ctx.getImageData(0, 0, w, h)
      
      const gridSpec = detectGrid(imageData)
      setDetectedGrid(gridSpec) // 保存检测结果供后续校准使用

      if (gridSpec.success) {
        // 检查是否与当前/默认尺寸接近
        const detectedSide = gridSpec.side
        // 用户要求强制对齐，因此移除 <0.25 的差异检查，只要尺寸在合理范围内（例如 >5px 且 <短边的1/3）就采纳
        const reasonable = detectedSide > 5 && detectedSide < Math.min(w, h) / 3
        
        if (reasonable) {
           console.log('Grid detected and aligned:', gridSpec)
           autoGrid = gridSpec
           // 关键修改：直接使用高精度的检测值，不进行任何取整
           finalSide = detectedSide
           
           // 设置排列方向
           finalArrangement = gridSpec.mode // 'horizontal' or 'vertical'
           setGridArrangement(finalArrangement)
           
           // 计算偏移量
           const spacing = gridSpec.spacing // H
           const anchors = gridSpec.anchors // [rho0, rho1, rho2]
           const H = spacing
           const S = detectedSide
           
           if (finalArrangement === 'horizontal') {
             // Horizontal Mode:
             // anchors[0] is for 90° normal (Horizontal lines y = rho)
             // anchors[1] is for 30° normal (120° lines)
             
             // 1. Determine the base OffsetY relative to origin (0,0)
             autoOffsetY = pMod(anchors[0], H)
             
             // 2. Determine which row index the detected line corresponds to
             // Detected line is at y = anchors[0].
             // Our grid lines are at y = autoOffsetY + k*H.
             // So k = round((anchors[0] - autoOffsetY) / H).
             const k = Math.round((anchors[0] - autoOffsetY) / H)
             
             // 3. Calculate intersection vertex X using BOTH diagonal sets for robustness
             // Line 30° (Normal): x*sqrt(3)/2 + y*0.5 = anchors[1]
             // => x1 = (anchors[1] - 0.5 * anchors[0]) / (Math.sqrt(3)/2)
             const vx1 = (anchors[1] - 0.5 * anchors[0]) / (Math.sqrt(3)/2)
             
             // Line 150° (Normal): x*(-sqrt(3)/2) + y*0.5 = anchors[2]
             // => -x*sqrt(3)/2 = anchors[2] - 0.5 * anchors[0]
             // => x2 = (0.5 * anchors[0] - anchors[2]) / (Math.sqrt(3)/2)
             const vx2 = (0.5 * anchors[0] - anchors[2]) / (Math.sqrt(3)/2)
             
             // Average for better precision
             const vx = (vx1 + vx2) / 2
             
             // 4. Determine OffsetX based on row parity
             // Even rows (k is even): Vertices at autoOffsetX + S/2 + m*S
             // Odd rows (k is odd): Vertices at autoOffsetX + m*S
             if (k % 2 === 0) {
                 // vx ~= autoOffsetX + S/2
                 autoOffsetX = pMod(vx - S / 2, S)
             } else {
                 // vx ~= autoOffsetX
                 autoOffsetX = pMod(vx, S)
             }
             
           } else {
             // Vertical Mode:
             // anchors[0] is for 0° normal (Vertical lines x = rho)
             // anchors[1] is for 60° normal
             
             // 1. Determine base OffsetX
             autoOffsetX = pMod(anchors[0], H)
             
             // 2. Determine col index
             const k = Math.round((anchors[0] - autoOffsetX) / H)
             
             // 3. Calculate intersection vertex Y using BOTH diagonal sets
             // Line 60° (Normal): x*0.5 + y*sqrt(3)/2 = anchors[1]
             // => y1 = (anchors[1] - 0.5 * anchors[0]) / (Math.sqrt(3)/2)
             const vy1 = (anchors[1] - 0.5 * anchors[0]) / (Math.sqrt(3)/2)
             
             // Line 120° (Normal): x*(-0.5) + y*sqrt(3)/2 = anchors[2]
             // => y2 = (anchors[2] + 0.5 * anchors[0]) / (Math.sqrt(3)/2)
             const vy2 = (anchors[2] + 0.5 * anchors[0]) / (Math.sqrt(3)/2)
             
             // Average
             const vy = (vy1 + vy2) / 2
             
             // 4. Determine OffsetY based on col parity
             // Even cols (k even): Vertices at autoOffsetY + S/2 + m*S
             // Odd cols (k odd): Vertices at autoOffsetY + m*S
             if (k % 2 === 0) {
                 autoOffsetY = pMod(vy - S / 2, S)
             } else {
                 autoOffsetY = pMod(vy, S)
             }
           }
           
           setGridOffsetX(autoOffsetX)
           setGridOffsetY(autoOffsetY)

           // 保存精确参数，供后续 rebuild 使用（绕过 UI 的整数限制）
           // 重要：网格必须是等边三角形，因此不保存/不使用 customH（高度只由 side 推导）
           setPreciseGridParams({
             side: detectedSide, // 原始检测值
             offsetX: autoOffsetX,
             offsetY: autoOffsetY,
             arrangement: finalArrangement,
             bounds: gridSpec.bounds // 仅用于可视化/裁剪参考
           })

           setStatus(`已自动对齐网格 (精确边长: ${detectedSide.toFixed(2)})`)
        } else {
           console.log('Grid detected but size unreasonable:', detectedSide)
           // 即使尺寸不匹配，也保存 gridSpec 供几何校准使用，但不重置参数
        }
      }
    } catch (e) {
      console.warn('Grid detection failed:', e)
    }

    const grid = (finalArrangement === 'horizontal')
      ? buildTriangleGrid(w, h, finalSide, autoOffsetX, autoOffsetY)
      : buildTriangleGridVertical(w, h, finalSide, autoOffsetX, autoOffsetY)
    if (autoGrid && Math.round(autoGrid.side) !== triangleSize) {
      // 同步 UI 滑块显示
      setTriangleSize(Math.round(autoGrid.side))
    } else if (!autoGrid && sideBase !== triangleSize) {
      setTriangleSize(sideBase)
    }
    setGrid(grid)

    const mapped = await mapImageToGrid(bitmap, grid, palette)
    
    // 如果自动检测成功，立即执行一次“少数服从多数”的强力校准
    if (autoGrid) {
        rectifyColorsByGrid(mapped, autoGrid)
        setStatus(`已自动对齐并校准颜色 (边长: ${autoGrid.side.toFixed(2)})`)
    }

    setTriangles(mapped)
    if (!autoGrid) setStatus('已识别颜色并生成网格')
    
    setUndoStack([mapped.map(t => t.color)])
    setRedoStack([])
    setStartId(null)
    setSelectedIds([])
    setSteps([])
    setEditMode(true)
    
    // 自动触发后台 AI 分析
    // 使用 setTimeout 将其放入下一次事件循环，避免阻塞主线程渲染
    setTimeout(() => {
        runBackgroundAiAnalysis(bitmap, grid, palette, mapped)
    }, 500)
  }, [triangleSize, gridArrangement, runBackgroundAiAnalysis]) // 移除 targetColorCount 依赖，避免闭包陈旧

  useEffect(() => {
    // 根据分离强度调节颜色匹配参数
    const penalty = colorSeparation
    const margin = 1.2 + 0.2 * colorSeparation
    const strongB = 10 + Math.max(0, colorSeparation - 4)
    setColorTuning({ GREY_PENALTY_BASE: penalty, WARM_MARGIN: margin, STRONG_B_TH: strongB })
    // 若处于导入工程状态，则不触发自动重建与重新识别
    if (loadedProject) return
    // 防抖：频繁拖动滑块时合并重建与映射，避免阻塞 UI
    if (rebuildTimerRef.current) { clearTimeout(rebuildTimerRef.current) }
    rebuildTimerRef.current = setTimeout(async () => {
      try {
        if (imgBitmap && palette.length && editMode) {
          // Check if we are re-entering edit mode with existing modified data
          // If triangles exist and look like they belong to the current image/grid config, 
          // we should KEEP them instead of rebuilding from scratch.
          // Simple heuristic: if we have triangles, and undoStack has history, 
          // or if we are just toggling editMode but didn't change grid params.
          
          // However, this effect runs on [triangleSize, gridArrangement, ..., editMode]
          // If editMode changed to true, we might want to preserve.
          // If triangleSize changed, we MUST rebuild.
          
          // Let's distinguish "param change" from "mode toggle".
          // We can use a ref to track the last used grid params.
          
          const currentParamsSignature = `${triangleSize}-${gridArrangement}-${gridOffsetX}-${gridOffsetY}-${imgBitmap.width}-${imgBitmap.height}`
          const lastParams = window.__lastGridParams || ''
          
          const isParamChange = currentParamsSignature !== lastParams
          
          if (!isParamChange && triangles && triangles.length > 0) {
             // Params didn't change, likely just entered edit mode or other minor update.
             // Preserve current triangles!
             // BUT, we must ensure grid is set if missing.
             if (!grid) {
                // ... rebuild grid only ...
             }
             return 
          }
          
          // Update last params
          window.__lastGridParams = currentParamsSignature
          
          const w = imgBitmap.width
          const h = imgBitmap.height
          
          // 决定使用哪个参数构建网格
          // 如果存在 preciseGridParams 且 triangleSize（UI值）与其接近（说明用户没有大幅拖动滑块破坏对齐）
          // 则优先使用精确参数
          let sideToUse = triangleSize
          let offX = gridOffsetX
          let offY = gridOffsetY
          let arr = gridArrangement
          let customH = null
          
          if (preciseGridParams && Math.abs(preciseGridParams.side - triangleSize) < 1.5) {
             sideToUse = preciseGridParams.side
             offX = preciseGridParams.offsetX
             offY = preciseGridParams.offsetY
             arr = preciseGridParams.arrangement
             // 等边网格：不使用 customH（避免三角形被拉伸成非等边）
             customH = null
             
             // 注意：detectedGrid.bounds 是“可见网格线段的外包矩形”，用于裁剪/可视化更合适，
             // 不应直接覆盖周期性 offset（offset 是取模意义上的相位），否则会导致网格整体漂移。
             
             // 保持 UI 状态一致
             if (arr !== gridArrangement) setGridArrangement(arr)
          }

          const gridNew = (arr === 'horizontal')
            ? buildTriangleGrid(w, h, sideToUse, offX, offY, customH)
            : buildTriangleGridVertical(w, h, sideToUse, offX, offY, customH)
          
          setGrid(gridNew)
          const mapped = await mapImageToGrid(imgBitmap, gridNew, palette)
          
          // 如果仍处于精确对齐模式，再次应用校准
          if (preciseGridParams && detectedGrid && Math.abs(preciseGridParams.side - triangleSize) < 1.5) {
             rectifyColorsByGrid(mapped, detectedGrid)
          }

          setTriangles(mapped)
          setUndoStack([mapped.map(t => t.color)])
          setRedoStack([])
          setStartId(null)
          setSteps([])
        } else if (!imgBitmap) {
          // 占位画布场景：允许三角形尺寸变化时重建网格，以便看到尺寸变化效果
          const w = grid?.width || 800
          const h = grid?.height || 600
          const g = (gridArrangement === 'horizontal')
            ? buildTriangleGrid(w, h, triangleSize, gridOffsetX, gridOffsetY)
            : buildTriangleGridVertical(w, h, triangleSize, gridOffsetX, gridOffsetY)
          setGrid(g)
          const base = g.triangles.map(t => ((t.up ?? t.left) ? '#1b2333' : '#121826'))
          setTriangles(g.triangles.map((t, i) => ({ ...t, color: base[i] })))
          // 记录初始快照，用于重置
          setUndoStack([base])
          setRedoStack([])
          setInitialPalette(palette)
          setInitialSelectedColor(palette[0] ?? null)
        }
      } finally {
        rebuildTimerRef.current = null
      }
    }, 150)
  }, [triangleSize, gridArrangement, loadedProject, colorSeparation, imgBitmap, editMode, preciseGridParams, detectedGrid, gridOffsetX, gridOffsetY])

  // 将缩放系数写入 CSS 变量，供画布样式使用
  useEffect(() => {
    try { document.documentElement.style.setProperty('--canvas-scale', String(canvasScale)) } catch {}
  }, [canvasScale])

  // Ctrl+滚轮缩放：锚定鼠标位置
  const getMinScale = useCallback(() => {
    try {
      const wrap = canvasWrapRef.current
      if (!wrap || !grid) return 0.2
      const ww = wrap.clientWidth
      const wh = wrap.clientHeight
      const swap = rotation === 90 || rotation === 270
      const cw = swap ? grid.height : grid.width
      const ch = swap ? grid.width : grid.height
      if (ww<=0 || wh<=0 || cw<=0 || ch<=0) return 0.2
      return Math.max(ww / cw, wh / ch)
    } catch { return 0.2 }
  }, [grid, rotation])

  useEffect(() => {
    const wrap = canvasWrapRef.current
    if (!wrap) return
    const onWheel = (e) => {
      // 支持 Ctrl+滚轮
      if (!e.ctrlKey) return
      
      const currentWrap = canvasWrapRef.current
      if (!currentWrap) return

      e.preventDefault()
      e.stopPropagation() // 阻止事件冒泡，防止浏览器缩放
      
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
      if (delta === 0) return

      const rect = currentWrap.getBoundingClientRect()
      // 获取实际的内容元素（第一个子元素），用于计算基于内容的坐标
      const content = currentWrap.firstElementChild
      if (!content) return
      const contentRect = content.getBoundingClientRect()
      
      // 1. 获取鼠标在 Content 中的相对位置
      // 修正：之前使用 scrollLeft 仅在左对齐时有效，居中时需用 contentRect
      const mouseContentX = e.clientX - contentRect.left
      const mouseContentY = e.clientY - contentRect.top
      
      const prevScale = scaleRef.current
      
      // 2. 计算鼠标在“原始无缩放网格”上的位置
      const mouseGridX = mouseContentX / prevScale
      const mouseGridY = mouseContentY / prevScale
      
      // 3. 计算新缩放
      const rawNextScale = prevScale * (delta < 0 ? 1.12 : 0.88)
      const nextScale = Math.max(0.1, Math.min(6, rawNextScale))
      
      // 4. 计算新的 Scroll 位置
      // 目标：缩放后，MouseGridX * NextScale (新内容坐标) 应该出现在 鼠标当前的视口坐标 处
      // 鼠标当前的视口相对坐标：MouseViewportX = e.clientX - rect.left
      // 理想的 ContentLeft 应该是：rect.left + MouseViewportX - (MouseGridX * NextScale)
      // 而 ScrollLeft = -(ContentLeft - rect.left)  (近似理解，实际是反向偏移)
      // 更直接的公式：
      // nextScrollLeft = (MouseGridX * NextScale) - MouseViewportX
      
      const mouseClientX = e.clientX - rect.left
      const mouseClientY = e.clientY - rect.top
      
      const nextScrollLeft = mouseGridX * nextScale - mouseClientX
      const nextScrollTop = mouseGridY * nextScale - mouseClientY
      
      // 记录预期滚动位置，待渲染完成后应用
      pendingScrollRef.current = { left: nextScrollLeft, top: nextScrollTop }
      
      scaleRef.current = nextScale
      setCanvasScale(nextScale)
    }
    // 添加 passive: false 以便能阻止默认的浏览器缩放行为
    // 同时在捕获阶段监听，确保优先处理
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // 保证视图始终铺满窗口：网格变化或旋转时，限制到最小填充缩放并居中
  useEffect(() => {
    if (!grid) return
    const minS = getMinScale()
    setCanvasScale(s => (s < minS ? minS : s))
    centerView()
  }, [grid, rotation])

  // 窗口尺寸变化时也维持铺满并居中
  useEffect(() => {
    const onResize = () => {
      const minS = getMinScale()
      setCanvasScale(s => (s < minS ? minS : s))
      centerView()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [getMinScale])

  // 图形颜色旋转（仅重映射颜色，不改变网格排列方向）
  // 顺时针旋转视图 90°（网格与识别图形一起，仅改变方向，不改变大小）
  const onRotate90 = useCallback(() => {
    setRotation(r => (r + 90) % 360)
    setStatus('已旋转视图 90°（网格与图形一起）')
    setTimeout(() => centerView(), 0)
  }, [centerView])

  // 键盘平移：WASD 与方向键 (操作滚动条)
  useEffect(() => {
    const onKeyPan = (e) => {
      const target = e.target
      const tag = target?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable
      if (isTyping) return
      const key = e.key
      // 滚动步长
      const step = 40
      const wrap = canvasWrapRef.current
      if (!wrap) return
      
      let dx = 0, dy = 0
      if (key === 'ArrowLeft') dx = -step
      else if (key === 'ArrowRight') dx = step
      else if (key === 'a' || key === 'A') dx = -step
      else if (key === 'd' || key === 'D') dx = step
      else if (key === 'ArrowUp') dy = -step
      else if (key === 'ArrowDown') dy = step
      else if (key === 'w' || key === 'W') dy = -step
      else if (key === 's' || key === 'S') dy = step
      if (dx !== 0 || dy !== 0) {
        e.preventDefault()
        wrap.scrollLeft += dx
        wrap.scrollTop += dy
      }
    }
    window.addEventListener('keydown', onKeyPan)
    return () => window.removeEventListener('keydown', onKeyPan)
  }, [])

  // 鼠标拖拽平移画布（中键或按住空格）
  useEffect(() => {
    const wrap = canvasWrapRef.current
    if (!wrap) return
    
    let isPanning = false
    let lastX = 0
    let lastY = 0

    const onMouseDown = (e) => {
      // 中键 (1) 或 按住空格时的左键 (0)
      if (e.button === 1 || (e.button === 0 && e.code === 'Space')) {
        e.preventDefault()
        isPanning = true
        lastX = e.clientX
        lastY = e.clientY
        wrap.style.cursor = 'grabbing'
      }
    }

    const onMouseMove = (e) => {
      if (!isPanning) return
      e.preventDefault()
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      
      // 拖拽逻辑：鼠标往左移，滚动条往右滚（视图左移）
      wrap.scrollLeft -= dx
      wrap.scrollTop -= dy
    }

    const onMouseUp = () => {
      if (isPanning) {
        isPanning = false
        wrap.style.cursor = ''
      }
    }

    wrap.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      wrap.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const onClickTriangle = useCallback((id, e) => {
    // 取色已改为彩虹色带点击，不使用画布取色；保持原选择逻辑
    // Ctrl 连通选择：选择与点击三角形同色、共享边连通的所有区域
    if (e?.ctrlKey) {
      if (!triangles || triangles.length===0) return
      const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
      const startIdx = idToIndex.get(id)
      const startTri = triangles[startIdx]
      if (!startTri || startTri.deleted || startTri.color==='transparent') return
      const color = startTri.color
      const region=[]
      const visited=new Set([id])
      const q=[id]
      while(q.length){
        const cid=q.shift()
        const idx=idToIndex.get(cid)
        const t=triangles[idx]
        if(t.deleted || t.color==='transparent' || t.color!==color) continue
        region.push(cid)
        for(const nb of t.neighbors){
          if(!visited.has(nb)){
            const nidx=idToIndex.get(nb)
            const t2=triangles[nidx]
            if(!t2.deleted && t2.color!=='transparent' && t2.color===color){
              visited.add(nb); q.push(nb)
            }
          }
        }
      }
      setSelectedIds(region)
      setStartId(id)
      setStatus(`已选择连通区域：${region.length} 个（颜色 ${color}）`)
      return
    }
    // Shift 多选：按住 Shift 进行增量选择/取消选择；否则单选
    if (e?.shiftKey) {
      setSelectedIds(prev => {
        const exists = prev.includes(id)
        const next = exists ? prev.filter(x=>x!==id) : [...prev, id]
        return next
      })
      setStartId(id)
      setStatus(`已${selectedIds.includes(id)?'取消':'添加'}选择：#${id}（当前共 ${selectedIds.includes(id)?selectedIds.length-1:selectedIds.length+1} 个）`)
    } else {
      setSelectedIds([id])
      setStartId(id)
      setStatus(`已选择三角形：#${id}`)
    }
  }, [selectedIds, triangles])

  const onPaint = useCallback(() => {
    if (!selectedColor || triangles.length === 0) return
    // 若存在多选，则对所有选中的三角形直接泼涂为当前选色
    if (selectedIds.length > 0) {
      const sel = new Set(selectedIds)
      const next = triangles.map(t => sel.has(t.id) ? { ...t, color: selectedColor } : t)
      const changedCount = triangles.reduce((acc, t) => acc + (sel.has(t.id) && t.color !== selectedColor ? 1 : 0), 0)
      if (changedCount === 0) { setStatus('提示：选中的三角形颜色已是目标色'); return }
      setTriangles(next)
      setUndoStack(prev => {
        const appended = [...prev, next.map(t => t.color)]
        return appended.length > 5 ? appended.slice(appended.length - 5) : appended
      })
      setRedoStack([])
      setHistoryStack(prev => {
        const appended = [...prev, { type: 'paint' }]
        return appended.length > 5 ? appended.slice(appended.length - 5) : appended
      })
      setHistoryRedoStack([])
      setStatus(isUniform(next) ? '成功：画布颜色已统一' : `泼涂：已应用到选中 ${changedCount} 个`)
      return
    }
    // 否则对起点的连通区域进行泼涂
    if (startId == null) { setStatus('请先选择起点或框选三角形'); return }
    const { newColors, changedIds } = floodFillRegion(triangles, startId, selectedColor)
    if (changedIds.length === 0) { setStatus('提示：起点区域颜色已是目标色'); return }
    const next = triangles.map((t, i) => ({ ...t, color: newColors[i] }))
    setTriangles(next)
    setUndoStack(prev => {
      const appended = [...prev, newColors]
      return appended.length > 5 ? appended.slice(appended.length - 5) : appended
    })
    setRedoStack([])
    setHistoryStack(prev => {
      const appended = [...prev, { type: 'paint' }]
      return appended.length > 5 ? appended.slice(appended.length - 5) : appended
    })
    setHistoryRedoStack([])
    setStatus(isUniform(next) ? '成功：画布颜色已统一' : `泼涂：连通区域 ${changedIds.length} 个`)
  }, [startId, selectedIds, selectedColor, triangles])

  const onUndo = useCallback(() => {
    if (historyStack.length === 0) return
    const action = historyStack[historyStack.length - 1]
    setHistoryStack(historyStack.slice(0, -1))
    setHistoryRedoStack(prev => [...prev, action])
    if (action.type === 'palette_add') {
      setPalette(p => {
        const idx = p.lastIndexOf(action.color)
        if (idx === -1) return p
        const next = [...p.slice(0, idx), ...p.slice(idx+1)]
        localStorage.setItem('palette', JSON.stringify(next))
        return next
      })
      setSelectedColor(action.prevSelectedColor || null)
      setStatus(`已撤销添加颜色：${action.color}`)
    } else if (action.type === 'paint') {
      if (undoStack.length <= 1) return
      const prev = [...undoStack]
      const last = prev.pop()
      setRedoStack(r => [...r, last])
      const colors = prev[prev.length - 1]
      setUndoStack(prev)
      setTriangles(triangles.map((t, i) => ({ ...t, color: colors[i] })))
      setStatus('已撤销')
    } else if (action.type === 'delete') {
      if (undoStack.length <= 1) return
      const prev = [...undoStack]
      const last = prev.pop()
      setRedoStack(r => [...r, last])
      const colors = prev[prev.length - 1]
      setUndoStack(prev)
      const toRestore = new Set(action.ids || [])
      setTriangles(triangles.map((t, i) => (
        toRestore.has(t.id)
          ? { ...t, deleted: false, color: colors[i] }
          : { ...t, color: colors[i], deleted: t.deleted }
      )))
      setStatus('已撤销删除')
    }
  }, [historyStack, undoStack, triangles])

  // 重做：回到“存档点”（由保存编辑设置），包含删除标记与颜色快照
  const onRedo = useCallback(() => {
    if (undoStack.length === 0) return
    const base = undoStack[0]
    const delSet = new Set(initialDeletedIds || [])
    setTriangles(triangles.map((t, i) => ({ ...t, color: base[i], deleted: delSet.has(t.id) })))
    setUndoStack([base])
    setRedoStack([])
    setHistoryStack([])
    setHistoryRedoStack([])
    setPalette(initialPalette)
    setSelectedColor(initialSelectedColor)
    setSelectedIds([])
    setStartId(null)
    setSteps([])
    setStatus('已重置到存档点')
  }, [undoStack, triangles, initialPalette, initialSelectedColor, initialDeletedIds])

  // 批量：选择同色三角形
  const onSelectSameColor = useCallback(() => {
    if (triangles.length === 0) return
    // 优先使用已选三角形的颜色，否则使用当前调色板选色
    let sourceColor = null
    if (startId != null) {
      sourceColor = triangles.find(t => t.id === startId)?.color || null
    } else if (selectedIds.length > 0) {
      sourceColor = triangles.find(t => t.id === selectedIds[0])?.color || null
    } else {
      sourceColor = selectedColor || null
    }
    if (!sourceColor) { setStatus('请先选择一个三角形或颜色'); return }
    const ids = triangles.filter(t => !t.deleted && t.color === sourceColor).map(t => t.id)
    setSelectedIds(ids)
    setStartId(ids[0] ?? null)
    setStatus(`已选择同色三角形：${ids.length} 个`)
  }, [triangles, startId, selectedIds, selectedColor])

  // 批量：将选中三角形替换为当前选色
  const onBulkReplaceToSelected = useCallback(() => {
    if (!selectedColor) { setStatus('请先在调色板选择目标颜色'); return }
    if (selectedIds.length === 0) { setStatus('请先选择要替换的三角形'); return }
    const sel = new Set(selectedIds)
    const next = triangles.map(t => sel.has(t.id) ? { ...t, color: selectedColor } : t)
    setTriangles(next)
    setUndoStack(prev => {
      const appended = [...prev, next.map(t => t.color)]
      return appended.length > 5 ? appended.slice(appended.length - 5) : appended
    })
    setRedoStack([])
    setStatus(isUniform(next) ? '成功：画布颜色已统一' : `批量替换完成：${selectedIds.length} 个`)
  }, [selectedIds, selectedColor, triangles])

  // 失败回退：生成接近统一的贪心步骤（5分钟超时或未统一时）
  const pickHeuristicStartId = useCallback((tris) => {
    // 优先按“桥接联通价值”选起点（与统计面板同款评分一致），避免从角落低价值块起手
    try {
      const focus = computeFocusAnchorIds(tris, { topK: 12, betweenK: 6, neighborK: 6 })
      if (focus && focus.length) return focus[0]
    } catch {}
    // 兜底：若统计失败再退回旧逻辑
    const counts = new Map()
    for (const t of tris) {
      if (t.deleted || t.color === 'transparent') continue
      counts.set(t.color, (counts.get(t.color) || 0) + 1)
    }
    let targetColor = null, max = 0
    for (const [c, n] of counts) { if (n > max) { max = n; targetColor = c } }
    const pick = tris.find(t => !t.deleted && t.color === targetColor)
    return pick?.id ?? (tris.find(t => !t.deleted && t.color !== 'transparent')?.id ?? tris[0]?.id)
  }, [])

  const isUniformColors = useCallback((colors, tris) => {
    const present = colors.filter((c, i) => !tris[i].deleted && c && c !== 'transparent')
    return new Set(present).size <= 1
  }, [])

  const computeRegion = useCallback((colors, startIdLocal, idToIndex, neighbors) => {
    const startIdx = idToIndex.get(startIdLocal)
    const startColorCur = colors[startIdx]
    const regionSet = new Set(); const q = [startIdLocal]; const visited = new Set([startIdLocal])
    while (q.length) {
      const id = q.shift(); const idx = idToIndex.get(id)
      if (colors[idx] !== startColorCur) continue
      regionSet.add(id)
      for (const nb of neighbors[idx]) { if (!visited.has(nb)) { visited.add(nb); q.push(nb) } }
    }
    return regionSet
  }, [])

  const expandedSize = useCallback((colors, regionSet, neighbors, candidateColor, idToIndex) => {
    const visited = new Set(regionSet)
    const queue = [...regionSet]
    while (queue.length) {
      const id = queue.shift()
      const idx = idToIndex.get(id)
      for (const nb of neighbors[idx]) {
        if (!visited.has(nb)) {
          const nidx = idToIndex.get(nb)
          if (colors[nidx] === candidateColor) { visited.add(nb); queue.push(nb) }
        }
      }
    }
    return visited.size
  }, [])

  // 兜底贪心：也按“桥接价值”走，多锚点（每步可换 startId），返回 action steps：[{startId,color}]
  const computeGreedyPath = useCallback((tris, pal, startCandidates, limit) => {
    const idToIndex = new Map(tris.map((t, i) => [t.id, i]))
    const neighbors = tris.map(t => t.neighbors)
    const colors = tris.map(t => t.color)

    const validStartIds = (Array.isArray(startCandidates) ? startCandidates : [])
      .filter(sid => sid != null && idToIndex.has(sid) && !tris[idToIndex.get(sid)]?.deleted && tris[idToIndex.get(sid)]?.color !== 'transparent')
    const fallbackSid = validStartIds[0] ?? pickHeuristicStartId(tris)

    const regionBridgeLocal = (regionSet) => {
      // 轻量桥接信号：邻接颜色数 + 邻接边界数（不看面积）
      const adjColors = new Set()
      let boundaryEdges = 0
      for (const id of regionSet) {
        const idx = idToIndex.get(id)
        const c0 = colors[idx]
        for (const nb of neighbors[idx] || []) {
          const nidx = idToIndex.get(nb)
          if (nidx == null) continue
          const tn = tris[nidx]
          if (!tn || tn.deleted) continue
          const cn = colors[nidx]
          if (!cn || cn === 'transparent') continue
          if (cn !== c0) { adjColors.add(cn); boundaryEdges++ }
        }
      }
      return (adjColors.size * 12) + (boundaryEdges * 0.35)
    }

    const applyOne = (sid, nextColor) => {
      const region = computeRegion(colors, sid, idToIndex, neighbors)
      for (const id of region) colors[idToIndex.get(id)] = nextColor
    }

    const path = []
    let guard = 0
    while (!isUniformColors(colors, tris) && path.length < limit && guard < 6000) {
      guard++

      // 选“当前桥接价值最高”的锚点（在 hubs 池里轮）
      let bestSid = fallbackSid
      let bestSidScore = -Infinity
      for (const sid of (validStartIds.length ? validStartIds : [fallbackSid])) {
        const region = computeRegion(colors, sid, idToIndex, neighbors)
        const s = regionBridgeLocal(region)
        if (s > bestSidScore) { bestSidScore = s; bestSid = sid }
      }

      const curColor = colors[idToIndex.get(bestSid)]
      const region0 = computeRegion(colors, bestSid, idToIndex, neighbors)
      const baseBridge = regionBridgeLocal(region0)
      let bestMove = null
      let bestScore = -Infinity
      for (const c of pal) {
        if (!c || c === curColor) continue
        // 禁止短周期振荡：A -> B -> A（同一 startId 下最常见的“来回换色不扩张”）
        if (path.length >= 2) {
          const prev2 = path[path.length - 2]
          const prev1 = path[path.length - 1]
          if (prev2?.startId === bestSid && prev1?.startId === bestSid && prev2?.color === c) continue
        }
        // 评分：优先桥接提升，其次扩张（弱）
        const size1 = expandedSize(colors, region0, neighbors, c, idToIndex)
        const delta = size1 - region0.size
        // 硬约束：不允许“0 扩张”步（会白白浪费步数）
        if (delta <= 0) continue
        // 模拟一步（局部复制：只改 region0）
        const changed = []
        for (const id of region0) { const idx = idToIndex.get(id); changed.push([idx, colors[idx]]); colors[idx] = c }
        const region1 = computeRegion(colors, bestSid, idToIndex, neighbors)
        const bridge1 = regionBridgeLocal(region1)
        // 回滚
        for (const [idx, old] of changed) colors[idx] = old

        const score = (bridge1 - baseBridge) * 2.5 + (size1 - region0.size) * 0.6
        if (score > bestScore) { bestScore = score; bestMove = c }
      }
      // 没有任何能扩张的 move，直接停（否则会出现“内部来回换色”）
      if (!bestMove) break
      applyOne(bestSid, bestMove)
      path.push({ startId: bestSid, color: bestMove })
    }
    return path
  }, [computeRegion, expandedSize, isUniformColors])

  const onSolve = useCallback(async () => {
    let __runId = null
    let graphSignature = null
    try {
      if (editMode) { setStatus('请先保存编辑，再进行自动求解'); return }
      if (triangles.length === 0) { setStatus('当前画布为空，无法求解'); return }
      if (!palette || palette.length < 2) { setStatus('调色板颜色不足，无法求解'); return }
      // 关键：若用 file:// 直接打开页面，Worker（尤其 module worker）会被浏览器拦截，必然“启动失败”
      try {
        if (typeof window !== 'undefined' && window.location && window.location.protocol === 'file:') {
          setStatus('检测到当前为 file:// 直接打开页面。浏览器会拦截 Worker，无法开始计算。请用本地服务器运行：npm run dev 或 npm run preview。')
          return
        }
      } catch {}
      setSolving(true)
      setStatus('计算中…')
      setSolveProgress({ phase: 'init' })
      setProgressLogs([])
      // 避免“上一次的不合格方案”残留造成误解：本次点击即清空旧步骤
      try { setSteps([]); setBestStartId(null) } catch {}
      solveStartRef.current = Date.now()
      contribRef.current = { branch_pruned: 0, enqueued: 0, expanded: 0, critical_hits: 0, path_len_reduction: 0, lb_improve_total: 0 }
      // 启动遥测 Run（不阻塞求解）
      graphSignature = makeGraphSignature(triangles, palette)
      try { const __r = await telemetryStartRun(triangles, palette, window.SOLVER_FLAGS); __runId = __r?.runId || null } catch {}
      const telemetrySafeLog = async (payload)=>{ try{ if(__runId) await telemetryLogEvent(__runId, payload) }catch{} }
      // 让出一次事件循环，确保“计算中…”与状态文案先渲染
      await new Promise(r => setTimeout(r, 0))
      // 1) 先查缓存（本地 IndexedDB → 后端 MongoDB），验证通过则直接返回（无需再计算）
      try {
        const cached = await getCachedSolution(graphSignature)
        if (cached?.paths?.[0] && cached?.startId != null) {
          const cachedPath = cached.paths[0]
          const cachedStart = cached.startId
          const cacheSource = cached?.__cacheSource || '?'
          // 统一性验证 + 步数上限验证（严格）
          const okUniform = verifyUnifiedPath({ triangles, startId: cachedStart, path: cachedPath })
          const okStep = (!Number.isFinite(maxStepsLimit) || (Array.isArray(cachedPath) && cachedPath.length <= maxStepsLimit))
          if (okUniform && okStep) {
            const snapshots = await buildStepSnapshots({ triangles, width: canvasRef.current.width, height: canvasRef.current.height, startId: cachedStart, path: cachedPath, maxSnap: 240, includeInitial: true })
            setSteps([{ path: cachedPath, images: snapshots }])
            setBestStartId(cachedStart)
            setStatus(`缓存命中(${cacheSource})：起点 #${cachedStart}，步骤 ${cachedPath.length}，上限 ${Number.isFinite(maxStepsLimit) ? maxStepsLimit : '∞'}`)
            setSolveProgress(null)
            try { await telemetrySafeLog({ status:'cache_hit', min_steps: cachedPath.length, best_start_id: cachedStart, graph_signature: graphSignature }) } catch {}
            try { await uploadStrategyAuto(triangles, palette, 'auto_solve_cache', cachedStart, cachedPath) } catch {}
            try { if(__runId) await telemetryFinishRun(__runId, { status:'cache_hit', min_steps: cachedPath.length, best_start_id: cachedStart, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
            setSolving(false)
            return
          } else {
            await telemetrySafeLog({ status:'cache_rejected', reason: okUniform ? (okStep?'unknown':'over_step_limit') : 'not_uniform', cached_len: cachedPath.length })
            // 不合格缓存：直接删除（本地 + 后端），避免继续命中脏数据
            try { await deleteCachedSolutionEverywhere(graphSignature) } catch {}
          }
        }
      } catch {}
      // 获取推荐参数与优先起点
      let preferredStartId = null
      // 本次求解复用：高价值锚点池（避免重复 computeRegionStats）
      let solveFocusAnchors = null
      // 本次求解复用：真实 top hubs（供 worker 的 hubAnchorIds）
      let solveHubAnchors = null
      try {
        const rec = await getRecommendation(graphSignature)
        if (rec?.flags_overrides) { window.SOLVER_FLAGS = { ...(window.SOLVER_FLAGS||{}), ...(rec.flags_overrides||{}) } }
        if (rec?.start_id!=null) { window.SOLVER_FLAGS.preferredStartId = rec.start_id; preferredStartId = rec.start_id }
        if (typeof rec?.lb_estimate==='number') { telemetrySafeLog({ phase:'recommend', extra: { lb_estimate: rec.lb_estimate } }) }
      } catch {}
      const maxBranches = 3
      // 仅使用本地计算：优先 Web Worker，失败则回退主线程
      let result = null
      // 强制使用 Web Worker，不再回退到主线程
      if (!result) {
        try {
          // -------------------- 并行 Worker 调度（最多 24，4 个一组策略） --------------------
          const HARD_BUDGET_MS = 180000
          const PAR_GROUP = 4
          const uiFlags0 = (window.SOLVER_FLAGS || {})
          const wantRaw = Number(uiFlags0.parallelWorkers)
          const want = Number.isFinite(wantRaw) ? Math.max(1, Math.min(24, Math.floor(wantRaw))) : 8
          const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ? Number(navigator.hardwareConcurrency) : null
          const allowOver = !!uiFlags0.parallelOvercommit
          // 默认保护：不超出硬件核心数（除非开启“超核”）
          const safeCap = (Number.isFinite(hw) && hw > 0 && !allowOver) ? Math.max(1, Math.min(24, hw)) : 24
          const capped = Math.min(want, safeCap)
          // 按 4 个一组向上取整（至少 8 以覆盖 2 组策略），但不超过 capped
          const groups = Math.max(2, Math.ceil(capped / PAR_GROUP))
          const PAR_N = Math.min(24, groups * PAR_GROUP)

          // 一次求解只算一次 anchors（避免重复 computeRegionStats）
          const topK = Math.max(8, Math.min(18, PAR_N))
          const hubs = (function(){
            try {
              const focus = computeFocusAnchorIds(triangles, { topK, betweenK: Math.max(6, Math.floor(topK/2)), neighborK: Math.max(6, Math.floor(topK/2)), pathK: Math.max(8, Math.floor(topK/2)), pathMaxDepth: 6 })
              if (preferredStartId!=null) {
                const idx = focus.indexOf(preferredStartId)
                if (idx > 0) { focus.splice(idx,1); focus.unshift(preferredStartId) }
                if (idx < 0) focus.unshift(preferredStartId)
              }
              return Array.from(new Set(focus))
            } catch { return preferredStartId!=null ? [preferredStartId] : [] }
          })()
          // 缓存供后续兜底使用（避免重复计算）
          solveFocusAnchors = hubs
          const hubAnchors = (function(){
            try { return computeHubAnchorIds(triangles, { topK: 6 }) } catch { return [] }
          })()
          solveHubAnchors = hubAnchors
          // A 组（半数线程）专用：两跳分候选起点池（按两跳分降序）。用于“内部优先串联 hubs”的分工。
          const twoHopIds = (function(){
            try { return computeInternalTwoHopIds(triangles, { hubsK: 6, topK: Math.max(6, Math.min(18, Math.ceil(PAR_N / 2))) }) } catch { return [] }
          })()
          const preferredList = []
          for (let i=0;i<PAR_N;i++){
            preferredList.push(hubs.length ? hubs[i % hubs.length] : null)
          }
          // 保底：如果取不到，退化为 null（让 worker 自选）
          while (preferredList.length < PAR_N) preferredList.push(null)

          // 多组策略：每 4 个一组。
          // 用户要求：始终优先“桥接联通价值”，避免从角落低价值区域开局。
          // 因此默认所有组都启用 multiAnchor（参数不同以覆盖更多局面），不再混入固定起点激进组作为默认。
          const mkFlags = (base, groupTag, groupLocalIdx, wIdx, totalWorkers, focusPack) => {
            const common = {
              ...base,
              workerTimeBudgetMs: HARD_BUDGET_MS,
              preprocessTimeBudgetMs: HARD_BUDGET_MS,
              maxNodes: Infinity,
              // 严格遵守用户步数上限：默认不允许自动放宽
              allowStepLimitRelax: false,
              // 让每个 worker 的随机/打散行为可区分（避免重复工作量）
              workerVariant: wIdx,
              // 共享焦点：来自“色块统计同款评分”的 top hubs（所有线程劲往一处使）
              focusAnchorIds: Array.isArray(focusPack?.focusAnchorIds) ? focusPack.focusAnchorIds : undefined,
              // 真实 hubs：仅用于“是否打通高评分hub”的奖励/惩罚/剪枝，避免把过渡/内部锚点误当 hub
              hubAnchorIds: Array.isArray(focusPack?.hubAnchorIds) ? focusPack.hubAnchorIds : undefined,
              focusPrimaryAnchorId: focusPack?.focusPrimaryAnchorId ?? undefined,
              internalBridgeIds: Array.isArray(focusPack?.internalBridgeIds) ? focusPack.internalBridgeIds : undefined,
              // 提示：worker 内部会根据 retry_degrade 自动降级；这里做“起始多样性”
            }
            // 线程分组：A=两跳组（半数线程），B=基础组（半数线程）
            const isGroupA = (groupTag === 'A')
            // 1/4 线程作为“近似组”：允许 stepLimit+1/+2 探索并尝试压回 stepLimit
            const tw = Number.isFinite(totalWorkers) ? totalWorkers : 0
            const nearCount = tw > 0 ? Math.max(1, Math.floor(tw / 4)) : 0
            const isNear = (nearCount > 0) ? (wIdx >= (tw - nearCount)) : false
            // 其中一半 near 线程允许 +2（更像“取消步骤限制”的折中：搜索更深，但输出仍严格 stepLimit）
            const near2Start = tw - Math.max(1, Math.floor(nearCount / 2))
            const extra = isNear ? ((wIdx >= near2Start) ? 2 : 1) : 0
            const nearPatch = isNear ? { allowNearMissStep: true, nearMissExtraSteps: extra } : { allowNearMissStep: false, nearMissExtraSteps: 0 }
            // mode 循环：全部 multiAnchor，只是强度不同
            // 0=标准多锚点；1=强桥接（更强 focus）；2=强多锚点（更大束/更多锚点）；3=强解锁（更重顺序解锁）
            // 组内策略轮转（避免重复工作量）：每组独立按 groupLocalIdx%4 分配 4 套参数
            const mode = groupLocalIdx % 4
            if (mode === 0) {
              return {
                ...common,
                ...nearPatch,
                internalBridgeOnly: !!isGroupA,
                // A 组：多锚点桥接策略（每步可换 startId）
                multiAnchor: true,
                // 更偏桥接与主色合并
                multiAnchorConnectW: Math.max(6, Number(common.multiAnchorConnectW||0) || 6),
                multiAnchorDomW: Math.max(3, Number(common.multiAnchorDomW||0) || 3),
                multiAnchorBdVarW: Math.max(1.2, Number(common.multiAnchorBdVarW||0) || 1.2),
                enableBridgeFirst: true,
                enableLB: true,
                enableBeam: true,
                beamWidth: Math.max(48, common.beamWidth ?? 32),
                beamMin: Math.max(12, common.beamMin ?? 8),
                lbImproveMin: Math.max(2, common.lbImproveMin ?? 1),
                useDFSFirst: false,
                returnFirstFeasible: false,
                // SAT 会触发后端请求，避免 24 线程同时打后端：只让 B 组的第 1 个线程尝试 SAT
                enableSATPlanner: (groupTag === 'B' && groupLocalIdx === 0),
              }
            }
            if (mode === 1) {
              // 强桥接：focus 更强，成本更低，更愿意先少步打通高桥接区域
              return {
                ...common,
                ...nearPatch,
                internalBridgeOnly: !!isGroupA,
                multiAnchor: true,
                multiAnchorFocusDepth: Math.max(3, Number(common.multiAnchorFocusDepth||0) || 3),
                multiAnchorFocusK: Math.max(3, Number(common.multiAnchorFocusK||0) || 3),
                multiAnchorConnectW: Math.max(14, Number(common.multiAnchorConnectW||12) || 12),
                multiAnchorCutW: Math.max(7, Number(common.multiAnchorCutW||6) || 6),
                multiAnchorCostW: Math.min(2.0, Number(common.multiAnchorCostW||2.2) || 2.2),
                enableBridgeFirst: true,
                enableLB: true,
                enableBeam: true,
                beamWidth: Math.max(56, common.beamWidth ?? 32),
                beamMin: Math.max(12, common.beamMin ?? 8),
                lbImproveMin: Math.max(1, common.lbImproveMin ?? 1),
                useDFSFirst: false,
                returnFirstFeasible: false,
                enableSATPlanner: false,
              }
            }
            if (mode === 2) {
              // 更强多锚点：更大束宽/更多锚点，适合极端散乱
              return {
                ...common,
                ...nearPatch,
                internalBridgeOnly: !!isGroupA,
                multiAnchor: true,
                multiAnchorBeamWidth: Math.min(96, Math.max(32, Number(common.multiAnchorBeamWidth||24) || 24)),
                multiAnchorAnchors: Math.min(24, Math.max(12, Number(common.multiAnchorAnchors||10) || 10)),
                multiAnchorColorsPerAnchor: Math.min(10, Math.max(5, Number(common.multiAnchorColorsPerAnchor||5) || 5)),
                enableBridgeFirst: true,
                enableLB: true,
                enableBeam: true,
                beamWidth: Math.max(64, common.beamWidth ?? 32),
                beamMin: Math.max(12, common.beamMin ?? 8),
                lbImproveMin: Math.max(1, common.lbImproveMin ?? 1),
                useDFSFirst: false,
                returnFirstFeasible: false,
                enableSATPlanner: false,
              }
            }
            // mode === 3：强解锁（顺序关键题型）
            return {
              ...common,
              ...nearPatch,
              internalBridgeOnly: !!isGroupA,
              multiAnchor: true,
              multiAnchorUnlockW: Math.max(2.2, Number(common.multiAnchorUnlockW||1.4) || 1.4),
              multiAnchorUnlockDepth: Math.max(1, Number(common.multiAnchorUnlockDepth||1) || 1),
              multiAnchorUnlockAnchors: Math.max(5, Number(common.multiAnchorUnlockAnchors||4) || 4),
              multiAnchorUnlockColors: Math.max(4, Number(common.multiAnchorUnlockColors||3) || 3),
              enableBridgeFirst: true,
              enableLB: true,
              enableBeam: true,
              beamWidth: Math.max(48, common.beamWidth ?? 32),
              beamMin: Math.max(12, common.beamMin ?? 8),
              lbImproveMin: Math.max(1, common.lbImproveMin ?? 1),
              useDFSFirst: false,
              returnFirstFeasible: false,
              enableSATPlanner: false,
            }
          }

          const flagsInitialBase = Number.isFinite(maxStepsLimit)
            ? { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false, useStrongLBInBestFirst: true, enableBeam: true, beamWidth: Math.max(24, window.SOLVER_FLAGS?.beamWidth ?? 32), beamMin: Math.max(10, window.SOLVER_FLAGS?.beamMin ?? 8), bifrontWeight: Math.max(2.2, window.SOLVER_FLAGS?.bifrontWeight ?? 2.0), rareAllowBridgeMin: Math.max(2.2, window.SOLVER_FLAGS?.rareAllowBridgeMin ?? 2.0), rareAllowGateMin: Math.max(1.2, window.SOLVER_FLAGS?.rareAllowGateMin ?? 1.0), lbImproveMin: Math.max(2, window.SOLVER_FLAGS?.lbImproveMin ?? 1) }
            : (window.SOLVER_FLAGS||{})

          const lightTris = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))

          const workers = []
          const states = Array.from({ length: PAR_N }, (_, i)=>({ i, last: null, best: null, nodes: 0, group: Math.floor(i / PAR_GROUP) }))
          let solved = false
          // 每个 worker 独立节流日志：避免 24 线程把主线程打爆
          const workerLogLastTs = Array.from({ length: PAR_N }, ()=>0)
          const workerLogCounts = Array.from({ length: PAR_N }, ()=>0)

          const cleanup = ()=>{
            for (const w of workers) { try { w.terminate() } catch {} }
            try { window.__solverWorker = null } catch {}
            try { window.__solverWorkers = null } catch {}
          }

          // 让 PerformanceTuner 的 set_flags 能广播到全部 worker（兼容旧接口）
          try {
            window.__solverWorkers = workers
            window.__solverWorker = {
              postMessage: (msg)=>{ try { for (const w of workers) w.postMessage(msg) } catch {} },
              terminate: ()=>{ try { for (const w of workers) w.terminate() } catch {} }
            }
          } catch {}

          const pickLeader = ()=>{
            // 规则：有 best_update 的优先；否则 nodes 最大者
            let leader = 0
            for (let i=0;i<states.length;i++){
              const a = states[leader], b = states[i]
              const aBest = a?.best?.minSteps
              const bBest = b?.best?.minSteps
              if (Number.isFinite(bBest) && !Number.isFinite(aBest)) { leader = i; continue }
              if (Number.isFinite(bBest) && Number.isFinite(aBest) && bBest < aBest) { leader = i; continue }
              if (!Number.isFinite(aBest) && !Number.isFinite(bBest) && (b.nodes||0) > (a.nodes||0)) { leader = i; continue }
            }
            return leader
          }

          const resPromise = new Promise((resolve, reject)=>{
            // 只在“合格解”出现时才允许提前结束；near-miss 只能记录，不能终止其它线程。
            let bestQualified = null // { bestStartId, path, len, payload, winner }
            let bestNearMiss = null  // { bestStartId, path, len }
            const finished = new Set()
            const startErrors = []
            const timeout = setTimeout(()=>{
              if (solved) return
              solved = true
              cleanup()
              // 不把算满时间当作异常：到点才允许返回 near-miss/近似（仍不算合格解）
              if (bestQualified) {
                resolve({ ...bestQualified.payload, bestStartId: bestQualified.bestStartId, paths: [bestQualified.path], minSteps: bestQualified.len, timedOut: false, __winner: bestQualified.winner })
              } else if (bestNearMiss) {
                resolve({ bestStartId: null, paths: [], minSteps: 0, timedOut: true, __timeout: true, nearMiss: bestNearMiss })
              } else {
                resolve({ bestStartId: null, paths: [], minSteps: 0, timedOut: true, __timeout: true })
              }
            }, HARD_BUDGET_MS + 25000)

            const half = Math.max(1, Math.floor(PAR_N / 2))
            // 严格组：按用户要求在 B 组中分出一半线程长期跑 strict（IDA*/A*）证明型搜索，其余线程继续 multiAnchor 覆盖搜索空间。
            const strictN = (function(){
              const ui = (window.SOLVER_FLAGS||{})
              if (!ui.strictMode) return 0
              const bCount = Math.max(0, PAR_N - half)
              const raw = Number(ui.strictParallelWorkers)
              if (Number.isFinite(raw)) return Math.max(0, Math.min(bCount, Math.floor(raw)))
              // 默认：B 组的一半（24线程 -> B=12 -> strict=6）
              return Math.max(0, Math.floor(bCount / 2))
            })()
            const strictWorkerSet = (function(){
              const set = new Set()
              // 仅从 B 组选取，且优先选 B 组“前半”：
              // 1) 避免与 near-miss（通常在末尾 1/4 线程）重叠
              // 2) 让严格组更稳定地长期跑
              for (let ii = half; ii < PAR_N && set.size < strictN; ii++){
                set.add(ii)
              }
              return set
            })()

            // PDB 下发（仅严格线程）：避免把巨大对象广播给所有 worker
            const pdbPayload = (function(){
              try {
                const key = 'pdb_6x6'
                const sourceObj = (typeof window !== 'undefined' && window.__PDB_AUTOLOAD__ && window.__PDB_AUTOLOAD__[key]) ? window.__PDB_AUTOLOAD__[key] : null
                if (sourceObj && typeof sourceObj === 'object') return { key, obj: sourceObj }
                const lsJson = localStorage?.getItem('PDB:' + key)
                if (lsJson) {
                  const obj = JSON.parse(lsJson)
                  if (obj && typeof obj === 'object') return { key, obj }
                }
              } catch {}
              return null
            })()

            const pushWorkerLog = (i, groupTag, msg, force=false)=>{
              const now = Date.now()
              const flagsUi = (window.SOLVER_FLAGS||{})
              const perWorkerInterval = Number.isFinite(flagsUi.progressAllWorkersIntervalMs)
                ? Math.max(0, flagsUi.progressAllWorkersIntervalMs)
                : 600
              if (!force && perWorkerInterval>0 && (now - (workerLogLastTs[i]||0)) < perWorkerInterval) return
              workerLogLastTs[i] = now
              workerLogCounts[i] = (workerLogCounts[i]||0) + 1
              const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] W${i+1}${groupTag} ${msg}`
              setProgressLogs(prev=>{
                const next = [...prev, line]
                return next.length>800 ? next.slice(next.length-800) : next
              })
            }

            // 记录每个 worker 的“策略/模块参与情况”，用于最终显示“合格解来自哪条线程、用了哪些模块”
            const workerMeta = Array.from({ length: PAR_N }, ()=>({
              modules: new Set(),
              strategy: [],
              preferredStartId: null,
              isStrict: false,
            }))
            const addMod = (i, m)=>{ try { if (m) workerMeta[i]?.modules?.add(String(m)) } catch {} }
            const addStrat = (i, s)=>{ try { if (s) workerMeta[i]?.strategy?.push(String(s)) } catch {} }
            const formatMeta = (i)=>{
              const m = workerMeta[i]
              const mods = Array.from(m?.modules||[])
              const st = Array.from(new Set(m?.strategy||[]))
              return {
                modules: mods.join('+') || '-',
                strategy: st.join('+') || '-',
                preferredStartId: m?.preferredStartId ?? null,
              }
            }
            const updateMetaByPhase = (i, groupTag, phase)=>{
              const ph = String(phase||'')
              if (!ph) return
              if (ph.includes('strict')) addMod(i, 'strict')
              if (ph.includes('ida')) addMod(i, 'IDA*')
              if (ph.includes('astar')) addMod(i, 'A*')
              if (ph.includes('mcts')) addMod(i, 'MCTS')
              if (ph.includes('sat')) addMod(i, 'SAT')
              if (ph.includes('rag')) addMod(i, 'RAG')
              if (ph.includes('optimize') || ph.includes('repair')) addMod(i, 'LocalRepair')
              if (ph.includes('dfs')) addMod(i, 'DFS')
              if (groupTag === 'A') addStrat(i, 'A组(两跳/DFS)')
              if (groupTag === 'B') addStrat(i, 'B组(基础/多策略)')
            }

            // 开始前先写一行：期望启动的 worker 数、严格线程编号
            try {
              const strictList = Array.from(strictWorkerSet).sort((a,b)=>a-b).map(x=>x+1)
              setProgressLogs(prev=>{
                const now = Date.now()
                const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] PAR start PAR_N=${PAR_N} strictWorkers=${strictList.join(',')||'-'}`
                const next = [...prev, line]
                return next.length>800 ? next.slice(next.length-800) : next
              })
            } catch {}

            for (let i=0;i<PAR_N;i++){
              const groupTag = (i < half) ? 'A' : 'B'
              const groupLocalIdx = (i < half) ? i : (i - half)
              let w = null
              try {
                w = new Worker(new URL('./utils/solver-worker.js', import.meta.url), { type: 'module' })
                workers.push(w)
                pushWorkerLog(i, groupTag, `worker_created`, true)
              } catch (e) {
                // worker 启动失败：在超核/内存紧张场景可能发生，直接跳过该 worker
                const errStr = String(e?.message||e)
                states[i].last = { phase:'worker_start_failed', error: errStr }
                startErrors.push(errStr)
                pushWorkerLog(i, groupTag, `worker_start_failed error=${errStr}`, true)
                continue
              }
              // A组：细分为3个子组，分别对应“两跳Top1/2/3”作为起点（focusPrimaryAnchorId），并启用 DFS 深度优先分工
              // B组：按基础 hubs 正常跑
              const aPoolFull = (Array.isArray(twoHopIds) && twoHopIds.length) ? twoHopIds : hubs
              const aTop3 = aPoolFull.slice(0, 3)
              const bPool = hubs
              const aLocal = (i < half) ? i : 0
              const aSub = (aLocal % 3) // 0/1/2 -> top1/top2/top3
              const aLane = Math.floor(aLocal / 3)
              const aLaneCount = Math.max(1, Math.ceil(half / 3))
              const aPrimary = (aTop3.length ? (aTop3[aSub % aTop3.length]) : (aPoolFull[0] ?? null))
              const primary = (groupTag === 'A')
                ? aPrimary
                : (bPool.length ? bPool[i % bPool.length] : (preferredList[i] ?? null))
              const isStrictWorker = strictWorkerSet.has(i)
              workerMeta[i].isStrict = !!isStrictWorker
              const flags0 = mkFlags(flagsInitialBase, groupTag, groupLocalIdx, i, PAR_N, {
                focusAnchorIds: hubs,
                hubAnchorIds: hubAnchors,
                // A组把 primary 作为 focusPrimaryAnchorId（组内错位），B组仍以 hub 为 primary
                focusPrimaryAnchorId: primary,
                // A组：每个子组只下发自己的 TopX 起点（避免三组互相干扰）；DFS分工通过 lane 参数避免重复路径
                internalBridgeIds: (groupTag === 'A') ? [aPrimary].filter(x=>x!=null) : [],
                internalSearchMode: (groupTag === 'A') ? 'dfs' : undefined,
                internalDfsSplitDepth: (groupTag === 'A') ? 2 : undefined,
                internalDfsLane: (groupTag === 'A') ? aLane : undefined,
                internalDfsLaneCount: (groupTag === 'A') ? aLaneCount : undefined,
                internalDfsLockAnchorDepth: (groupTag === 'A') ? 3 : undefined,
              })
              // 严格组分工：在 B 组前半的 strictN 个线程上，使用不同的 preferredStartId / IDA* vs A* / 轻微排序权重差异，减少重复工作量
              const strictLocal = (i >= half) ? (i - half) : -1
              const strictIdx = (strictLocal >= 0) ? strictLocal : -1
              const strictPreferred = (bPool && bPool.length && strictIdx >= 0) ? bPool[Math.min(bPool.length-1, strictIdx % bPool.length)] : primary
              const strictHeuristicName = (pdbPayload?.key === 'pdb_6x6') ? 'layered_pdb_6x6_max' : 'dynamic_rag_max'
              const strictUseIDA = (strictIdx % 6 === 0) ? false : true // 1 条线程用 A*（补位），其余默认 IDA*
              const strictDispW = [0.45, 0.55, 0.65, 0.75, 0.85, 0.95][Math.max(0, strictIdx % 6)]
              const flags = isStrictWorker
                ? {
                    ...(flags0||{}),
                    // 严格线程：把预算留给 strict IDA*，禁用种子/多锚点阶段
                    strictMode: true,
                    useIDAStar: strictUseIDA,
                    heuristicName: strictHeuristicName,
                    skipSeedPhase: true,
                    multiAnchor: false,
                    internalBridgeOnly: false,
                    allowNearMissStep: false,
                    nearMissExtraSteps: 0,
                    useDFSFirst: false,
                    returnFirstFeasible: false,
                    dispersionWeight: strictDispW,
                  }
                : {
                    ...(flags0||{}),
                    // 非严格线程：即便全局默认开启 strictMode，也不进入 strict IDA*，保证 24 线程覆盖搜索空间
                    strictMode: false,
                    useIDAStar: false,
                    // 非严格线程的 strict-probe 使用轻量启发式，避免因未注入 PDB 导致 h≈0
                    heuristicName: 'dynamic_rag_max',
                    skipSeedPhase: false,
                  }

              // 严格线程尝试注入 PDB（如果主线程有本地 PDB 数据）
              if (isStrictWorker && pdbPayload?.key && pdbPayload?.obj) {
                try { w.postMessage({ type:'load_pdb', key: pdbPayload.key, obj: pdbPayload.obj }) } catch {}
                addMod(i, 'PDB')
              }

              try { w.postMessage({ type:'set_flags', flags }) } catch {}
              if (isStrictWorker) {
                addStrat(i, `Strict(${strictUseIDA ? 'IDA*' : 'A*'})`)
                addStrat(i, `h=${strictHeuristicName}`)
                addStrat(i, `dispW=${strictDispW}`)
              } else {
                if (groupTag === 'A') addStrat(i, 'multiAnchor+内部DFS分工')
                if (groupTag === 'B') addStrat(i, 'multiAnchor(基础轮转)')
              }
              // 降低卡顿：并行时显著放慢 progress 上报（每个 worker 独立节流）
              // A 组更需要反馈（但 DFS 深度优先也会更“啃”），B 组更慢；leader UI 仍会二次节流。
              try {
                const progressPostIntervalMs = isStrictWorker ? 420 : ((groupTag === 'A') ? 120 : 260)
                w.postMessage({ type:'set_flags', flags: { progressPostIntervalMs } })
              } catch {}

              // 捕获 worker 级别异常：确保日志里能看到哪个线程挂了
              try {
                w.onerror = (ev)=>{
                  const msg = String(ev?.message || ev?.type || 'worker_error')
                  pushWorkerLog(i, groupTag, `onerror ${msg}`, true)
                }
                w.onmessageerror = (ev)=>{
                  pushWorkerLog(i, groupTag, `onmessageerror`, true)
                }
              } catch {}

              w.onmessage = (ev)=>{
                const { type, payload } = ev.data || {}
                if (solved) return
                // 所有 worker 的关键事件都要写日志（便于核对 24 线程是否都在正常跑）
                if (type === 'init_done') {
                  pushWorkerLog(i, groupTag, `init_done triangles=${payload?.triangles??'-'} palette=${payload?.palette??'-'}`, true)
                } else if (type === 'flags_set') {
                  pushWorkerLog(i, groupTag, `flags_set ok=${payload?.ok??'-'}`, true)
                } else if (type === 'pdb_loaded') {
                  pushWorkerLog(i, groupTag, `pdb_loaded ok=${payload?.ok??false} key=${payload?.key??'-'}${payload?.error?` err=${String(payload.error).slice(0,120)}`:''}`, true)
                  if (payload?.ok) addMod(i, 'PDB')
                }
                if (type === 'progress') {
                  const p = payload
                  const now = Date.now()
                  states[i].last = p
                  states[i].nodes = p?.nodes ?? states[i].nodes ?? 0
                  if (p?.phase === 'best_update' && Number.isFinite(p?.minSteps)) {
                    states[i].best = { minSteps: p.minSteps, bestStartId: p.bestStartId }
                  }
                  updateMetaByPhase(i, groupTag, p?.phase)
                  const leader = pickLeader()
                  // 所有 worker 都写“轻量日志”（独立节流），leader 继续驱动 UI 更新
                  {
                    const perf = p?.perf || {}
                    const phaseRaw = p?.phase || 'search'
                    const extra = (function(){
                      if (phaseRaw==='branch_pruned') {
                        return ` reason=${p?.reason??'-'} step=${p?.step??'-'} color=${p?.color??'-'}`
                      } else if (phaseRaw==='branch_quality') {
                        const dr = (typeof p?.deltaRatio==='number') ? (p.deltaRatio.toFixed(3)) : (p?.deltaRatio??'-')
                        return ` step=${p?.step??'-'} color=${p?.color??'-'} delta=${p?.delta??'-'} dr=${dr} lb=${p?.lb??'-'} prio=${p?.priority??'-'}`
                      } else if (phaseRaw==='retry_degrade') {
                        return ` retry=${p?.retry??'-'}`
                      }
                      return ''
                    })()
                    pushWorkerLog(i, groupTag, `phase=${phaseRaw}${extra} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`, false)
                  }
                  if (i !== leader) return

                  const flagsUi = (window.SOLVER_FLAGS||{})
                  const compPhases = ['components','components_build','components_analysis']
                  const strictPhases = ['strict_astar']
                  const intervalCfg = compPhases.includes(p?.phase)
                    ? (flagsUi.progressComponentsIntervalMs ?? 0)
                    : strictPhases.includes(p?.phase)
                      ? (flagsUi.progressAStarIntervalMs ?? 80)
                      : (flagsUi.progressDFSIntervalMs ?? 100)
                  if (!(intervalCfg===0 || (now - progressLastRef.current) >= intervalCfg)) return

                  const nodes = p?.nodes ?? 0
                  const sols = p?.solutions ?? 0
                  const phase = p?.phase === 'components' ? `已识别连通分量：${p?.count}`
                    : p?.phase === 'components_build' ? `正在构建分量：${p?.count}（当前大小 ${p?.compSize??'-'}）`
                    : p?.phase === 'best_update' ? `已更新最优：起点 #${p?.bestStartId}，最少步骤 ${p?.minSteps}`
                    : p?.phase === 'near_miss' ? `发现近似解：${p?.len}步（超1步），正在尝试压回 ${p?.stepLimit} 步…`
                    : p?.phase === 'retry_degrade' ? `降级重试：${p?.retry ?? '-'}`
                    : `已探索节点：${nodes}，候选分支：${sols}`

                  setStatus(`计算中… ${phase}`)
                  setSolveProgress({
                    phase: p?.phase,
                    nodes: p?.nodes,
                    solutions: p?.solutions,
                    queue: p?.queue,
                    components: p?.count,
                    bestStartId: p?.bestStartId,
                    minSteps: p?.minSteps,
                    elapsedMs: now - solveStartRef.current,
                    perf: p?.perf,
                  })

                  const perf = p?.perf || {}
                  const phaseRaw = p?.phase || 'search'
                  const compInfo = (phaseRaw==='components' || phaseRaw==='components_build')
                    ? ` count=${p?.count??0}${p?.compSize!=null?` compSize=${p.compSize}`:''}`
                    : ''
                  const extra = (function(){
                    if (phaseRaw==='branch_pruned') {
                      return ` reason=${p?.reason??'-'} step=${p?.step??'-'} color=${p?.color??'-'}`
                    } else if (phaseRaw==='branch_quality') {
                      const dr = (typeof p?.deltaRatio==='number') ? (p.deltaRatio.toFixed(3)) : (p?.deltaRatio??'-')
                      return ` step=${p?.step??'-'} color=${p?.color??'-'} delta=${p?.delta??'-'} dr=${dr} lb=${p?.lb??'-'} prio=${p?.priority??'-'}`
                    } else if (phaseRaw==='components_analysis') {
                      return ` count=${p?.count??0}`
                    } else if (phaseRaw==='retry_degrade') {
                      return ` retry=${p?.retry??'-'}`
                    }
                    return ''
                  })()
                  if (typeof perf?.filteredZero === 'number') { contribRef.current.branch_pruned += perf.filteredZero }
                  if (typeof perf?.enqueued === 'number') { contribRef.current.enqueued += perf.enqueued }
                  if (typeof perf?.expanded === 'number') { contribRef.current.expanded += perf.expanded }
                  const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] W${i+1}${groupTag} phase=${phaseRaw}${compInfo}${extra} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
                  setProgressLogs(prev=>{
                    const next = [...prev, line]
                    return next.length>200 ? next.slice(next.length-200) : next
                  })
                  progressLastRef.current = now
                } else if (type === 'result') {
                  finished.add(i)
                  pushWorkerLog(i, groupTag, `result minSteps=${payload?.minSteps??'-'} timedOut=${payload?.timedOut??'-'} bestStartId=${payload?.bestStartId??'-'}`, true)
                  const winner = { workerIndex: i, group: groupTag, preferredStartId: primary ?? preferredList[i] }
                  // 只要返回的 paths 里存在“合格解”，就立刻结束；否则只记录 near-miss，继续跑满时间。
                  try {
                    const sid = payload?.bestStartId
                    const paths = Array.isArray(payload?.paths) ? payload.paths : []
                    const qualified = []
                    for (const p of paths) {
                      if (!Array.isArray(p) || p.length === 0) continue
                      if (sid == null) continue
                      const okStep = (!Number.isFinite(maxStepsLimit) || p.length <= maxStepsLimit)
                      if (!okStep) continue
                      const okUniform = verifyUnifiedPath({ triangles, startId: sid, path: p })
                      if (okUniform) qualified.push(p)
                    }
                    if (qualified.length) {
                      qualified.sort((a,b)=>a.length-b.length)
                      const bestP = qualified[0]
                      // 把“模块参与/策略摘要”打包进 winnerDetail，供最终进度窗口展示
                      const meta = formatMeta(i)
                      const winnerDetail = { ...winner, preferredStartId: meta.preferredStartId ?? winner.preferredStartId, strategy: meta.strategy, modules: meta.modules }
                      bestQualified = { bestStartId: sid, path: bestP, len: bestP.length, payload, winner: winnerDetail }
                      solved = true
                      clearTimeout(timeout)
                      cleanup()
                      pushWorkerLog(i, groupTag, `QUALIFIED len=${bestP.length} strategy=${winnerDetail.strategy} modules=${winnerDetail.modules}`, true)
                      resolve({ ...payload, bestStartId: sid, paths: [bestP], minSteps: bestP.length, timedOut: false, __winner: winnerDetail })
                      return
                    }
                    // 记录 near-miss（只取更短的），但不能结束计算
                    const nm = payload?.nearMiss
                    if (nm?.path && Array.isArray(nm.path) && nm.path.length > 0 && Number.isFinite(nm.len)) {
                      if (!bestNearMiss || nm.len < bestNearMiss.len) {
                        bestNearMiss = { bestStartId: nm.bestStartId, path: nm.path, len: nm.len }
                      }
                    }
                  } catch {}
                }
              }

              // 分批启动 worker，降低瞬时卡顿（尤其 24 线程）
              const pref = (isStrictWorker ? strictPreferred : (primary ?? preferredList[i]))
              workerMeta[i].preferredStartId = pref
              if (isStrictWorker) addStrat(i, `prefStart=#${pref}`)
              try { w.postMessage({ type:'init', triangles: lightTris, palette }) } catch {}
              setTimeout(() => {
                try { w.postMessage({ type:'auto', maxBranches, stepLimit: maxStepsLimit, preferredStartId: pref }) } catch {}
              }, Math.min(400, i * 18))
            }

            // 若没有任何 worker 成功启动，直接返回 timedOut（非异常）
            if (workers.length === 0) {
              clearTimeout(timeout)
              solved = true
              cleanup()
              resolve({ bestStartId: null, paths: [], minSteps: 0, timedOut: true, __timeout: true, __noWorkers: true, __startError: startErrors[0] || null })
            }
          })

          result = await resPromise
          // ------------------ end parallel block ------------------
        } catch (wErr) {
          try{ window.__solverWorker = null }catch{}
          // 回退：使用窗口内的自动求解器
          // result = await window.Solver_minStepsAuto?.(lightTris2, palette, maxBranches, (p)=>{
          // ... (整个回退逻辑注释掉) ...
          // }, Number.isFinite(maxStepsLimit) ? maxStepsLimit : 80)
          // 不再把 worker-timeout 作为“求解错误”
          const msg = String(wErr?.message || wErr || '')
          if (/worker-timeout/i.test(msg)) {
            // 只有真正跑到超时才算 __timeout
            result = { bestStartId: null, paths: [], minSteps: 0, timedOut: true, __timeout: true }
          } else {
            console.error('Worker failed, but skipping main thread fallback to enforce worker logic', wErr)
            // 其它异常：不能当作“时间到”，否则会立刻返回近似解（看起来像没算）。
            result = { bestStartId: null, paths: [], minSteps: 0, timedOut: true, __timeout: false, __error: msg, __failed: true }
          }
        }
      }
      // 严格审核：只认“全局统一 + 满足 stepLimit”的合格解
      const sidFinal = result?.bestStartId
      let unifiedPaths = (result?.paths||[]).filter(p=>{
        if (!Array.isArray(p) || p.length===0) return false
        if (sidFinal == null) return false
        const okStep = (!Number.isFinite(maxStepsLimit) || p.length <= maxStepsLimit)
        if (!okStep) return false
        return verifyUnifiedPath({ triangles, startId: sidFinal, path: p })
      })
      // 若没有合格解：允许返回 near-miss（+1/+2）或兜底近似方案用于参考，但这些都“不算合格解”，不得缓存/不得写入后端解库。
      if (!result || unifiedPaths.length === 0 || !result.bestStartId) {
        // worker 全部启动失败：这不是“算满 3 分钟”，不允许返回任何近似解（否则看起来像“立刻返回不合格解”）
        if (result?.__noWorkers) {
          setSteps([])
          setBestStartId(null)
          const err = result?.__startError ? ` 启动错误：${String(result.__startError).slice(0, 160)}` : ''
          setStatus(`计算线程启动失败（Worker 未能启动），无法开始计算。${err}（请使用 npm run dev / npm run preview 运行，或换浏览器重试）`)
          setSolveProgress(null)
          try { if(__runId) await telemetryFinishRun(__runId, { status:'no_workers', min_steps: 0, best_start_id: null, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
          return
        }
        // 1) 优先 near-miss（来自 worker 的 +1/+2 探索）
        if ((result?.__timeout === true) && result?.nearMiss?.path && Array.isArray(result.nearMiss.path) && result.nearMiss.path.length > 0) {
          try {
            const nm = result.nearMiss
            const startIdLocal = nm.bestStartId ?? (startId!=null ? startId : pickHeuristicStartId(triangles))
            const snaps = await buildStepSnapshots({ triangles, width: canvasRef.current.width, height: canvasRef.current.height, startId: startIdLocal, path: nm.path, maxSnap: 240, includeInitial: true })
            setSteps([{ path: nm.path, images: snaps }])
            setBestStartId(startIdLocal)
            const baseLim = Number.isFinite(maxStepsLimit) ? maxStepsLimit : (nm.len - 1)
            const extra = Math.max(1, nm.len - baseLim)
            setStatus(`3分钟内未找到合格解（≤${baseLim}步）。已返回 +${extra}步近似解（${nm.len}步，仅供参考，不缓存/不入库）。`)
            setSolveProgress(null)
            // 不缓存、不入库（包括不调用 saveCachedSolutionWithPuzzle / uploadStrategyAuto）
            try { if(__runId) await telemetryFinishRun(__runId, { status:'near_miss', min_steps: nm.len, best_start_id: startIdLocal, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
            return
          } catch {}
        }

        // 2) 再兜底给一个“参考解”（可能不统一/可能超步数），但仍不入库
        try {
          // 只有时间到（算满预算）才允许给近似兜底
          if (!(result?.__timeout === true)) throw new Error('not_timed_out')
          const hubs = (function(){
            try { return (Array.isArray(solveFocusAnchors) && solveFocusAnchors.length) ? solveFocusAnchors : computeFocusAnchorIds(triangles, { topK: 18, betweenK: 10, neighborK: 10, pathK: 14, pathMaxDepth: 6 }) } catch { return [] }
          })()
          const startIdLocal = (result?.bestStartId!=null) ? result.bestStartId : (startId!=null ? startId : (hubs[0] ?? pickHeuristicStartId(triangles)))
          const heurLimit = Number.isFinite(maxStepsLimit) ? Math.max(1, Math.min(40, maxStepsLimit + 2)) : 40
          const heurPath = computeGreedyPath(triangles, palette, hubs.length ? hubs : [startIdLocal], heurLimit)
          if (heurPath && heurPath.length) {
            const snapshots = await buildStepSnapshots({ triangles, width: canvasRef.current.width, height: canvasRef.current.height, startId: startIdLocal, path: heurPath, maxSnap: 240, includeInitial: true })
            setSteps([{ path: heurPath, images: snapshots }])
            setBestStartId(startIdLocal)
            setStatus(`3分钟内未找到合格解（并行已耗尽预算）。已给出近似方案（仅供参考，不缓存/不入库）：起点 #${startIdLocal}，步骤 ${heurPath.length}`)
            setSolveProgress(null)
            try { if(__runId) await telemetryFinishRun(__runId, { status:'fallback', min_steps: heurPath.length, best_start_id: startIdLocal, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
            return
          }
        } catch {}

        // 若并行流程失败（非超时），不要返回任何近似解/旧解
        if (result?.__failed) {
          setSteps([])
          setBestStartId(null)
          const em = String(result?.__error || '').trim()
          const tail = em ? `（错误：${em.slice(0, 180)}）` : ''
          setStatus(`计算线程启动/运行异常，未能进入计算流程（已阻止返回不合格解）。请刷新后重试。${tail}`)
          setSolveProgress(null)
          try { if(__runId) await telemetryFinishRun(__runId, { status:'worker_failed', error: String(result?.__error||''), min_steps: 0, best_start_id: null, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
          return
        }
        setSteps([])
        setBestStartId(null)
        setStatus(`3分钟内未找到合格解（≤${Number.isFinite(maxStepsLimit) ? maxStepsLimit : '∞'}步）。`)
        setSolveProgress(null)
        try { if(__runId) await telemetryFinishRun(__runId, { status:'no_solution', min_steps: 0, best_start_id: null, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
        return
      }
      if (!result || result.paths.length === 0 || !result.bestStartId) {
        if (result?.timedOut) {
          setStatus('提示：计算时间超出预算或达到上限，已提前停止。可尝试减小图片尺寸、降低三角形数量或提高预算。')
        } else {
          setStatus('未找到可行解或超出计算上限')
        }
        setSolveProgress(null)
        // 结束遥测并上传空策略摘要，确保特征与记录被采集
        try { await uploadStrategyAuto(triangles, palette, result?.timedOut ? 'auto_solve_timeout' : 'auto_solve_none', result?.bestStartId ?? null, []) } catch {}
        
        try { if(__runId) await telemetryFinishRun(__runId, { status: result?.timedOut ? 'timeout' : 'no_solution', min_steps: 0, best_start_id: result?.bestStartId ?? null, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
        return
      }
      const SNAPSHOT_LIMIT = 40
      const stepImgs = []
      // 避免在主线程进行大量 Canvas 绘制，减少白屏风险
      // 实际上 captureCanvasPNG 是同步的，如果 path 很长或分支多，会卡死 UI
      // 优化：每生成一个分支的快照后，强制让出主线程
      for (const path of unifiedPaths) {
        // 分批生成快照，不要一次性生成全部 40 张
        // 实际上 captureCanvasPNG 目前是一次性生成全部，我们可以让它只生成关键帧，或者分片
        // 这里暂时保持逻辑，但增加更频繁的 yield
        
        setStatus(`正在生成步骤快照… (${stepImgs.length+1}/${unifiedPaths.length})`)
        // 使用 await 确保状态更新有机会渲染
        await new Promise(r => setTimeout(r, 10))
        
        // 注意：captureCanvasPNG 现在只返回最后一张图作为“结果预览”？
        // 不，根据 solver.js 的逻辑，它只返回一张图。
        // 如果需要每一步的快照，captureCanvasPNG 需要修改，或者在这里循环调用
        // 之前的逻辑似乎是 captureCanvasPNG 返回一个数组？
        // 让我们检查 solver.js 的实现...
        // 刚刚修改的 captureCanvasPNG 接收 steps 参数，并在内部循环 apply，但只 draw 一次（最后状态）。
        // 这意味着它只返回一张图片（DataURL string），而不是数组。
        // 但 StepsPanel 期望 images 是一个数组 (branch.images.map)。
        // 这就是 "branch.images.map is not a function" 的原因！
        // captureCanvasPNG 返回的是 string，str.map 当然报错。
        
        // 修正方案：
        // 1. 我们需要生成一系列图片。
        // 2. 在这里循环调用 captureCanvasPNG，或者修改 captureCanvasPNG 让它返回数组。
        // 为了性能，我们只生成关键帧（例如每步一张，或者首尾+中间）。
        // 鉴于性能压力，我们改为：只生成【初始状态】、【每一步的状态】。
        
        const snapshots = []
        // 初始状态
        snapshots.push(await captureCanvasPNG(triangles, canvasRef.current.width, canvasRef.current.height, result.bestStartId, []))
        
        // 生成每一步的快照 (限制数量)
        let currentPath = []
        for(let k=0; k<Math.min(path.length, SNAPSHOT_LIMIT); k++){
           currentPath.push(path[k])
           // 每隔几步生成一张，或者每步都生成（如果不想卡死，建议每步生成）
           // 但这非常慢。
           // 暂时每步生成
           snapshots.push(await captureCanvasPNG(triangles, canvasRef.current.width, canvasRef.current.height, result.bestStartId, currentPath))
           if(k % 5 === 0) await new Promise(r=>setTimeout(r,0)) 
        }
        
        stepImgs.push({ path: path, images: snapshots })
      }
      setSteps(stepImgs)
      setBestStartId(result.bestStartId ?? null)
      const win = result?.__winner
      const winStr = (win && Number.isFinite(win.workerIndex))
        ? `；合格解来自 W${(win.workerIndex+1)}${win.group||''}${win.preferredStartId!=null?`（pref #${win.preferredStartId}）`:''}${win.strategy?`；策略=${win.strategy}`:''}${win.modules?`；模块=${win.modules}`:''}`
        : ''
      setStatus(`计算完成（自动起点 #${result.bestStartId}），最少步骤：${result.minSteps}，合格分支：${unifiedPaths.length}${winStr}`)
      setSolveProgress(null)
      // 只缓存/上传“合格解”：必须统一颜色，且满足用户 stepLimit（严格）
      try {
        const bestPath = unifiedPaths?.[0]
        const okUniform = (bestPath && result.bestStartId!=null) ? verifyUnifiedPath({ triangles, startId: result.bestStartId, path: bestPath }) : false
        const okStep = (bestPath && Array.isArray(bestPath)) ? (!Number.isFinite(maxStepsLimit) || bestPath.length <= maxStepsLimit) : false
        if (okUniform && okStep) {
          // 合格解日志：单独存入浏览器“求解日志库”，用于后续调试复盘；不会被“清除解缓存”删除
          try {
            const win = result?.__winner || null
            const lines = Array.isArray(progressLogsRef.current) ? progressLogsRef.current.slice(-800) : []
            await saveQualifiedSolveLog({
              graph_signature: graphSignature,
              timestamp: Date.now(),
              min_steps: bestPath.length,
              best_start_id: result.bestStartId,
              winner: win,
              summary: `QUALIFIED len=${bestPath.length} start=${result.bestStartId} winner=${win?.workerIndex!=null?('W'+(win.workerIndex+1)+(win.group||'')):'-'}`,
              // 仅保留关键字段，避免过大
              flags: (function(){
                try {
                  const f = window.SOLVER_FLAGS || {}
                  return {
                    strictMode: !!f.strictMode,
                    strictParallelWorkers: f.strictParallelWorkers ?? null,
                    enableSATPlanner: !!f.enableSATPlanner,
                    enableRAGMacro: !!f.enableRAGMacro,
                    enableLearningPrioritizer: !!f.enableLearningPrioritizer,
                    heuristicName: f.heuristicName || null,
                    parallelWorkers: f.parallelWorkers ?? null,
                  }
                } catch { return null }
              })(),
              lines,
            })
          } catch {}
          await saveCachedSolutionWithPuzzle(graphSignature, { startId: result.bestStartId, paths: [bestPath], minSteps: bestPath.length }, makePuzzlePayload(triangles, palette), window.SOLVER_FLAGS)
          await uploadStrategyAuto(triangles, palette, 'auto_solve', result.bestStartId, bestPath)
          await recordRunScore(graphSignature, { run_id: __runId, algo_name: (window.SOLVER_FLAGS?.heuristicName||'default'), min_steps: bestPath.length, best_start_id: result.bestStartId, time_ms: Date.now() - solveStartRef.current, is_unified: true, quality: 'final', source: 'auto_solve', flags: window.SOLVER_FLAGS })
        } else {
          // 不合格解：不入库/不缓存，避免下次直接命中
          try { await telemetrySafeLog({ status:'not_cached', reason: okUniform ? (okStep?'unknown':'over_step_limit') : 'not_uniform', min_steps: result.minSteps }) } catch {}
        }
      } catch {}
      try { await postLearnScore(graphSignature, { run_id: __runId, graph_signature: graphSignature, is_unified: true, path_len: result.minSteps, algo_scores: (()=>{ const m = { lb_improve_total: contribRef.current.lb_improve_total||0, branch_pruned_count: contribRef.current.branch_pruned||0, expansion_saved_est: Math.max(0, (contribRef.current.enqueued||0)-(contribRef.current.expanded||0)), critical_hits: contribRef.current.critical_hits||0, path_len_reduction: contribRef.current.path_len_reduction||0 }; const w = { lb:0.35, prune:0.25, expand:0.25, critical:0.10, path:0.05 }; const denom = Math.max(1, m.lb_improve_total + m.branch_pruned_count + m.expansion_saved_est + m.critical_hits + m.path_len_reduction); const norm = { lb: m.lb_improve_total/denom, prune: m.branch_pruned_count/denom, expand: m.expansion_saved_est/denom, critical: m.critical_hits/denom, path: m.path_len_reduction/denom }; const f = window.SOLVER_FLAGS||{}; const mods = []; const add=(key, engaged)=>{ if(!engaged) return; const score=100*(w.lb*norm.lb + w.prune*norm.prune + w.expand*norm.expand + w.critical*norm.critical + w.path*norm.path); mods.push({ key, score, metrics: m })}; add('ucb_prioritizer', !!f.enableLearningPrioritizer); add('bridge_first', !!f.enableBridgeFirst); add('best_first', !!f.enableBestFirst); add('a_star_lb', !!f.useAStarInBestFirst || !!f.useStrongLBInBestFirst); add('beam_search', !!f.enableBeam); add('lookahead', !!f.enableLookahead || !!f.enableLookaheadDepth2); add('zero_expand_filter', !!f.enableZeroExpandFilter); add('pdb', !!f.enablePDBAutoLoad); add('local_repair', !!f.optimizeEnableWindow || !!f.optimizeEnableRemoval || (Number(f.optimizeSwapPasses)||0)>0 ); add('sat_planner', !!f.enableSATPlanner); return mods; })() }) } catch {}
      // 结束遥测 Run
      try { if(__runId) await telemetryFinishRun(__runId, { status:'finished', min_steps: result.minSteps, best_start_id: result.bestStartId, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
    } catch (err) {
      console.error('Auto-solve error:', err)
      setStatus('求解过程中发生错误')
      
      try { if(__runId) await telemetryFinishRun(__runId, { status:'error', error: String(err?.message||err), time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
    } finally {
      setSolving(false)
    }
  }, [triangles, palette, editMode, maxStepsLimit])

  // 继续计算最短步骤：在已有可行方案基础上，切换到 BFS/Best-First 求全局最短
  const onContinueShortest = useCallback(async () => {
    let __runId2 = null
    let graphSignature2 = null
    try {
      if (editMode) { setStatus('请先保存编辑，再继续计算最短步骤'); return }
      if (!steps || steps.length === 0) { setStatus('暂无可行方案，先执行自动求解'); return }
      setSolving(true)
      setStatus('计算中…')
      setSolveProgress({ phase: 'init' })
      setProgressLogs([])
      solveStartRef.current = Date.now()
      // 启动遥测 Run（不阻塞）与缓存优先
      graphSignature2 = makeGraphSignature(triangles, palette)
      try { const __r2 = await telemetryStartRun(triangles, palette, { ...(window.SOLVER_FLAGS||{}), mode: 'continue_shortest' }); __runId2 = __r2?.runId || null } catch {}
      const telemetrySafeLog2 = async (payload)=>{ try{ if(__runId2) await telemetryLogEvent(__runId2, payload) }catch{} }
      // 尝试命中缓存（本地→后端）：命中且通过统一性/步数校验则直接返回，避免重复计算
      try {
        const cached = await getCachedSolution(graphSignature2)
        const cachedPath = cached?.paths?.[0]
        const cachedStart = cached?.startId
        const cacheSource = cached?.__cacheSource || '?'
        if (cachedPath && cachedPath.length > 0 && cachedStart != null) {
          const okUniform = verifyUnifiedPath({ triangles, startId: cachedStart, path: cachedPath })
          const okStep = (!Number.isFinite(maxStepsLimit) || cachedPath.length <= maxStepsLimit)
          if (okUniform && okStep) {
            const snapshots = await buildStepSnapshots({ triangles, width: canvasRef.current.width, height: canvasRef.current.height, startId: cachedStart, path: cachedPath, maxSnap: 240, includeInitial: true })
            setSteps([{ path: cachedPath, images: snapshots }])
            setBestStartId(cachedStart)
            setStatus(`缓存命中(${cacheSource})：步骤 ${cachedPath.length}（起点 #${cachedStart}），上限 ${Number.isFinite(maxStepsLimit) ? maxStepsLimit : '∞'}`)
            setSolveProgress(null)
            try { await telemetrySafeLog2({ status:'cache_hit', min_steps: cachedPath.length, best_start_id: cachedStart, graph_signature: graphSignature2 }) } catch {}
            try { await uploadStrategyAuto(triangles, palette, 'continue_shortest_cache', cachedStart, cachedPath) } catch {}
            try { if(__runId2) await telemetryFinishRun(__runId2, { status:'cache_hit', min_steps: cachedPath.length, best_start_id: cachedStart, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature2 }) } catch {}
            setSolving(false)
            return
          }
          // 不合格缓存：直接删除（本地 + 后端）
          try { await deleteCachedSolutionEverywhere(graphSignature2) } catch {}
        }
      } catch {}
      await new Promise(r=>setTimeout(r,0))
      const maxBranches = 3
      let result = null
      try {
        const worker = new Worker(new URL('./utils/solver-worker.js', import.meta.url), { type: 'module' })
        try { window.__solverWorker = worker } catch {}
        const resPromise = new Promise((resolve, reject)=>{
          const timeout = setTimeout(()=>{ try{ worker.terminate() }catch{}; try{ window.__solverWorker = null }catch{}; reject(new Error('worker-timeout')) }, 300000)
          worker.onmessage = (ev)=>{
            const { type, payload } = ev.data || {}
            if(type==='progress'){
              const p = payload
              const now = Date.now()
              if (now - progressLastRef.current > 200) {
                const nodes = p?.nodes ?? 0
                const sols = p?.solutions ?? 0
                const phase = p?.phase === 'components' ? `已识别连通分量：${p?.count}`
                  : p?.phase === 'components_build' ? `正在构建分量：${p?.count}（当前大小 ${p?.compSize??'-'}）`
                  : p?.phase === 'best_update' ? `已更新最优：起点 #${p?.bestStartId}，最少步骤 ${p?.minSteps}`
                  : `已探索节点：${nodes}，候选分支：${sols}`
                setStatus(`计算中… ${phase}`)
            setSolveProgress({
              phase: p?.phase,
              nodes: p?.nodes,
              solutions: p?.solutions,
              queue: p?.queue,
              components: p?.count,
              bestStartId: p?.bestStartId,
              minSteps: p?.minSteps,
              elapsedMs: now - solveStartRef.current,
              perf: p?.perf,
            })
            // 发送进度遥测
            telemetrySafeLog2({
              phase: p?.phase,
              nodes: p?.nodes,
              solutions: p?.solutions,
              queue: p?.queue,
              perf: p?.perf,
              extra: { bestStartId: p?.bestStartId, minSteps: p?.minSteps, count: p?.count }
            })
                const perf = p?.perf || {}
                const phaseRaw3 = p?.phase || 'search'
                const compInfo3 = (phaseRaw3==='components' || phaseRaw3==='components_build')
                  ? ` count=${p?.count??0}${p?.compSize!=null?` compSize=${p.compSize}`:''}`
                  : ''
                const extra3 = (function(){
                  if (phaseRaw3==='branch_pruned') {
                    return ` reason=${p?.reason??'-'} step=${p?.step??'-'} color=${p?.color??'-'}`
                  } else if (phaseRaw3==='branch_quality') {
                    const dr = (typeof p?.deltaRatio==='number') ? (p.deltaRatio.toFixed(3)) : (p?.deltaRatio??'-')
                    return ` step=${p?.step??'-'} color=${p?.color??'-'} delta=${p?.delta??'-'} dr=${dr} lb=${p?.lb??'-'} prio=${p?.priority??'-'}`
                  } else if (phaseRaw3==='components_analysis') {
                    return ` count=${p?.count??0}`
                  }
                  return ''
                })()
                if (phaseRaw3==='branch_quality' && typeof p?.lb === 'number') { contribRef.current.lb_improve_total += Math.max(0, p.lb) }
                if (typeof perf?.filteredZero === 'number') { contribRef.current.branch_pruned += perf.filteredZero }
                if (typeof perf?.enqueued === 'number') { contribRef.current.enqueued += perf.enqueued }
                if (typeof perf?.expanded === 'number') { contribRef.current.expanded += perf.expanded }
                const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phaseRaw3}${compInfo3}${extra3} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
                setProgressLogs(prev=>{
                  const next = [...prev, line]
                  return next.length>200 ? next.slice(next.length-200) : next
                })
                progressLastRef.current = now
              }
            } else if(type==='result'){
              // clearTimeout(timeout)
              try{ worker.terminate() }catch{}
              try{ window.__solverWorker = null }catch{}
              resolve(payload)
            }
          }
        })
        // 覆写 flags：在有限步数时加强最短路搜索（关闭 DFS-first/早停，启用强下界）
        const flags = Number.isFinite(maxStepsLimit)
          ? { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false, useStrongLBInBestFirst: true, enableBeam: true, beamWidth: Math.max(24, window.SOLVER_FLAGS?.beamWidth ?? 32), beamMin: Math.max(10, window.SOLVER_FLAGS?.beamMin ?? 8), bifrontWeight: Math.max(2.2, window.SOLVER_FLAGS?.bifrontWeight ?? 2.0), lbImproveMin: Math.max(2, window.SOLVER_FLAGS?.lbImproveMin ?? 1) }
          : { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false }
        try { worker.postMessage({ type:'set_flags', flags }) } catch {}
        const lightTris3 = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
        // 先 init 缓存 puzzle，再发 auto（后续若只调 flags/stepLimit，可只发 auto 不带 triangles/palette）
        try { worker.postMessage({ type:'init', triangles: lightTris3, palette }) } catch {}
        worker.postMessage({ type:'auto', maxBranches, stepLimit: maxStepsLimit })
        result = await resPromise
      } catch (err) {
        try{ window.__solverWorker = null }catch{}
        // 回退到主线程
        const lightTris4 = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
        const __oldFlags = (window.SOLVER_FLAGS || {})
        const __boundedFlags = Number.isFinite(maxStepsLimit)
          ? { ...__oldFlags, useDFSFirst: false, returnFirstFeasible: false, useStrongLBInBestFirst: true, enableBeam: true, beamWidth: Math.max(24, __oldFlags.beamWidth ?? 32), beamMin: Math.max(10, __oldFlags.beamMin ?? 8), bifrontWeight: Math.max(2.2, __oldFlags.bifrontWeight ?? 2.0), lbImproveMin: Math.max(2, __oldFlags.lbImproveMin ?? 1) }
          : __oldFlags
        if (Number.isFinite(maxStepsLimit)) window.SOLVER_FLAGS = __boundedFlags
        try {
          result = await window.Solver_minStepsAuto?.(lightTris4, palette, 3, (p)=>{
            const now = Date.now()
            if (now - progressLastRef.current > 200) {
              const nodes = p?.nodes ?? 0
              const sols = p?.solutions ?? 0
              const phase = p?.phase === 'components' ? `已识别连通分量：${p?.count}`
                : p?.phase === 'best_update' ? `已更新最优：起点 #${p?.bestStartId}，最少步骤 ${p?.minSteps}`
                : `已探索节点：${nodes}，候选分支：${sols}`
              setStatus(`正在继续计算最短步骤… ${phase}`)
              setSolveProgress({ phase:p?.phase, nodes:p?.nodes, solutions:p?.solutions, queue:p?.queue, components:p?.count, bestStartId:p?.bestStartId, minSteps:p?.minSteps, elapsedMs: now - solveStartRef.current, perf: p?.perf })
              const perf = p?.perf || {}
              if (typeof perf?.filteredZero === 'number') { contribRef.current.branch_pruned += perf.filteredZero }
              if (typeof perf?.enqueued === 'number') { contribRef.current.enqueued += perf.enqueued }
              if (typeof perf?.expanded === 'number') { contribRef.current.expanded += perf.expanded }
              const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${p?.phase||'search'} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
              setProgressLogs(prev=>{ const next=[...prev,line]; return next.length>200 ? next.slice(next.length-200) : next })
              progressLastRef.current = now
              telemetrySafeLog2({ phase: p?.phase, nodes: p?.nodes, solutions: p?.solutions, queue: p?.queue, perf: p?.perf, extra: { bestStartId: p?.bestStartId, minSteps: p?.minSteps, count: p?.count } })
            }
          }, Number.isFinite(maxStepsLimit) ? maxStepsLimit : 80)
        } finally {
          if (Number.isFinite(maxStepsLimit)) window.SOLVER_FLAGS = __oldFlags
        }
      }

      // 最终展示最短方案
      const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
      const neighbors = triangles.map(t=>t.neighbors)
      const checkUnified = (path)=>{
        let colors = triangles.map(t=>t.color)
        const applyOne = (sid, color)=>{
          const idxS = idToIndex.get(sid)
          if (idxS==null) return false
          const startColorCur = colors[idxS]
          if(color===startColorCur) return true
          const regionSet = new Set(); const q=[sid]; const visited=new Set([sid])
          while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==startColorCur) continue; regionSet.add(id); for(const nb of neighbors[idx]){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } } }
          for(const id of regionSet){ colors[idToIndex.get(id)] = color }
          return true
        }
        const fallbackStart = result.bestStartId
        for(const step of path){
          const isObj = step && typeof step === 'object'
          const sid = isObj ? step.startId : fallbackStart
          const color = isObj ? step.color : step
          if (sid==null || !color) return false
          if (!applyOne(sid, color)) return false
        }
        const finalTris = triangles.map((t,i)=>({ ...t, color: colors[i] }))
        return isUniform(finalTris)
      }
      const unifiedPaths = (result?.paths||[]).filter(p=>checkUnified(p) && (!Number.isFinite(maxStepsLimit) || (Array.isArray(p) && p.length <= maxStepsLimit)))
      if (!result || unifiedPaths.length === 0 || !result.bestStartId) {
        setStatus('继续计算最短步骤失败或未统一，请重试')
        setSolveProgress(null)
        return
      }
      const stepImgs = []
      const SNAPSHOT_LIMIT = 40
      for (const path of unifiedPaths) {
        setStatus(`正在生成步骤快照… (${stepImgs.length+1}/${result.paths.length})`)
        const snapshots = await buildStepSnapshots({ triangles, width: canvasRef.current.width, height: canvasRef.current.height, startId: result.bestStartId, path, maxSnap: SNAPSHOT_LIMIT, includeInitial: true })
         stepImgs.push({ path, images: snapshots })
        await new Promise(r=>setTimeout(r,0))
      }
      setSteps(stepImgs)
      setBestStartId(result.bestStartId ?? null)
      setStatus(`已更新为最短步骤（自动起点 #${result.bestStartId}），最少步骤：${result.minSteps}`)
      setSolveProgress(null)
      try {
        const bestPath = unifiedPaths?.[0]
        const okUniform = (bestPath && result.bestStartId!=null) ? verifyUnifiedPath({ triangles, startId: result.bestStartId, path: bestPath }) : false
        const okStep = (bestPath && Array.isArray(bestPath)) ? (!Number.isFinite(maxStepsLimit) || bestPath.length <= maxStepsLimit) : false
        if (okUniform && okStep) {
          try {
            const win = result?.__winner || null
            const lines = Array.isArray(progressLogsRef.current) ? progressLogsRef.current.slice(-800) : []
            await saveQualifiedSolveLog({
              graph_signature: graphSignature2,
              timestamp: Date.now(),
              min_steps: bestPath.length,
              best_start_id: result.bestStartId,
              winner: win,
              summary: `QUALIFIED(continue_shortest) len=${bestPath.length} start=${result.bestStartId} winner=${win?.workerIndex!=null?('W'+(win.workerIndex+1)+(win.group||'')):'-'}`,
              flags: (function(){
                try {
                  const f = window.SOLVER_FLAGS || {}
                  return {
                    strictMode: !!f.strictMode,
                    strictParallelWorkers: f.strictParallelWorkers ?? null,
                    enableSATPlanner: !!f.enableSATPlanner,
                    enableRAGMacro: !!f.enableRAGMacro,
                    enableLearningPrioritizer: !!f.enableLearningPrioritizer,
                    heuristicName: f.heuristicName || null,
                    parallelWorkers: f.parallelWorkers ?? null,
                    mode: 'continue_shortest',
                  }
                } catch { return null }
              })(),
              lines,
            })
          } catch {}
          await saveCachedSolutionWithPuzzle(graphSignature2, { startId: result.bestStartId, paths: [bestPath], minSteps: bestPath.length }, makePuzzlePayload(triangles, palette), window.SOLVER_FLAGS)
          await uploadStrategyAuto(triangles, palette, 'continue_shortest', result.bestStartId, bestPath)
          await recordRunScore(graphSignature2, { run_id: __runId2, algo_name: (window.SOLVER_FLAGS?.heuristicName||'default'), min_steps: bestPath.length, best_start_id: result.bestStartId, time_ms: Date.now() - solveStartRef.current, is_unified: true, quality: 'final', source: 'continue_shortest', flags: window.SOLVER_FLAGS })
        }
      } catch {}
            try { await postLearnScore(graphSignature2, { run_id: __runId2, graph_signature: graphSignature2, is_unified: true, path_len: result.minSteps, algo_scores: (()=>{ const m = { lb_improve_total: contribRef.current.lb_improve_total||0, branch_pruned_count: contribRef.current.branch_pruned||0, expansion_saved_est: Math.max(0, (contribRef.current.enqueued||0)-(contribRef.current.expanded||0)), critical_hits: contribRef.current.critical_hits||0, path_len_reduction: contribRef.current.path_len_reduction||0 }; const w = { lb:0.35, prune:0.25, expand:0.25, critical:0.10, path:0.05 }; const denom = Math.max(1, m.lb_improve_total + m.branch_pruned_count + m.expansion_saved_est + m.critical_hits + m.path_len_reduction); const norm = { lb: m.lb_improve_total/denom, prune: m.branch_pruned_count/denom, expand: m.expansion_saved_est/denom, critical: m.critical_hits/denom, path: m.path_len_reduction/denom }; const f = window.SOLVER_FLAGS||{}; const mods = []; const add=(key, engaged)=>{ if(!engaged) return; const score=100*(w.lb*norm.lb + w.prune*norm.prune + w.expand*norm.expand + w.critical*norm.critical + w.path*norm.path); mods.push({ key, score, metrics: m })}; add('ucb_prioritizer', !!f.enableLearningPrioritizer); add('bridge_first', !!f.enableBridgeFirst); add('best_first', !!f.enableBestFirst); add('a_star_lb', !!f.useAStarInBestFirst || !!f.useStrongLBInBestFirst); add('beam_search', !!f.enableBeam); add('lookahead', !!f.enableLookahead || !!f.enableLookaheadDepth2); add('zero_expand_filter', !!f.enableZeroExpandFilter); add('pdb', !!f.enablePDBAutoLoad); add('local_repair', !!f.optimizeEnableWindow || !!f.optimizeEnableRemoval || (Number(f.optimizeSwapPasses)||0)>0 ); add('sat_planner', !!f.enableSATPlanner); return mods; })() }) } catch {}
      try { if(__runId2) await telemetryFinishRun(__runId2, { status:'finished', min_steps: result.minSteps, best_start_id: result.bestStartId, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature2 }) } catch {}
    } catch (err) {
      console.error('Continue shortest error:', err)
      setStatus('继续计算最短步骤时发生错误')
      
      try { if(__runId2) await telemetryFinishRun(__runId2, { status:'error', error: String(err?.message||err), time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature2 }) } catch {}
    } finally {
      setSolving(false)
    }
  }, [steps, triangles, palette, editMode, maxStepsLimit, bestStartId])

  // 路径优化（反思/压缩）：利用 OptimizeSolution 分析关键节点并尝试缩短
  const onOptimizePath = useCallback(async () => {
    let __runId3 = null
    let graphSignature3 = null
    try {
      if (!steps || steps.length === 0) { setStatus('暂无可行方案，先执行自动求解'); return }
      const originalPath = steps[0]?.path
      const sid = bestStartId ?? pickHeuristicStartId(triangles)
      setSolving(true)
      setStatus('计算中…')
      setSolveProgress({ phase: 'optimize_init' })
      setProgressLogs([])
      solveStartRef.current = Date.now()
      // 启动遥测 Run（不阻塞）
      graphSignature3 = makeGraphSignature(triangles, palette)
      try { const __r3 = await telemetryStartRun(triangles, palette, { ...(window.SOLVER_FLAGS||{}), mode: 'optimize_path' }); __runId3 = __r3?.runId || null } catch {}
      const telemetrySafeLog3 = async (payload)=>{ try{ if(__runId3) await telemetryLogEvent(__runId3, payload) }catch{} }
      await new Promise(r=>setTimeout(r,0))
      let result = null
      // 并行优化：复用并行线程配置，启动 N 个 worker 同时优化当前方案；参数分组避免重复。
      // 不影响正常调度：不触碰 window.__solverWorker/__solverWorkers（只在本函数内部管理并终止）。
      try {
        const uiFlags0 = (window.SOLVER_FLAGS || {})
        const wantRaw = Number(uiFlags0.parallelWorkers)
        const want = Number.isFinite(wantRaw) ? Math.max(1, Math.min(24, Math.floor(wantRaw))) : 8
        const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ? Number(navigator.hardwareConcurrency) : null
        const allowOver = !!uiFlags0.parallelOvercommit
        const safeCap = (Number.isFinite(hw) && hw > 0 && !allowOver) ? Math.max(1, Math.min(24, hw)) : 24
        const PAR_N = Math.min(want, safeCap)

        const workers = []
        const results = []
        const startTs = Date.now()
        const hardTimeout = Math.max(20000, Math.min(120000, (uiFlags0.optimizeTimeBudgetMs ?? 60000)))

        const lightTris = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
        // 优化也继承“高评分hub/内部桥梁”策略：否则容易只在慢扩张路线里微调，错过两步破局
        const focusIds = (function(){
          try { return computeFocusAnchorIds(triangles, { topK: 18, betweenK: 10, neighborK: 10, pathK: 14, pathMaxDepth: 6 }) } catch { return [] }
        })()
        const hubIds = (function(){
          try { return computeHubAnchorIds(triangles, { topK: 6 }) } catch { return [] }
        })()
        const internalIds = (function(){
          // 优化阶段不需要 top3 限死：取较多候选，提高“多线程不同点试探”的覆盖面
          try { return computeInternalTwoHopIds(triangles, { hubsK: 6, topK: 12 }) } catch { return [] }
        })()

        const mkOptFlags = (wIdx)=>{
          const mode = wIdx % 6
          // 大多数 worker 只做局部优化（更轻），少量 worker 做全局重算（更重）
          const enableGlobal = (mode === 0 || mode === 3)
          const internalOnly = (mode === 0 || mode === 3) && internalIds.length
          const base = { ...(window.SOLVER_FLAGS||{}), mode: 'optimize_path', workerVariant: wIdx }
          return {
            ...base,
            focusAnchorIds: focusIds,
            hubAnchorIds: hubIds,
            internalBridgeIds: internalIds,
            internalBridgeOnly: !!internalOnly,
            optimizeTimeBudgetMs: Math.max(8000, Math.floor(hardTimeout * (enableGlobal ? 1.0 : 0.55))),
            optimizeEnableGlobalSearch: enableGlobal,
            // 参数扰动：避免重复
            optimizeWindowSize: (mode===1?6: mode===2?4: 5),
            optimizeEnableBeamWindow: (mode===2 || mode===3),
            optimizeBeamWidth: (mode===3?6: mode===2?4: 3),
            optimizeBeamWindows: (mode===3?3: 2),
            optimizeEnableRemoval: true,
            optimizeEnableBoundTrim: (mode!==4),
            optimizeEnableSwap: true,
            optimizeSwapPasses: (mode===5?2:1),
            // 进一步强化“省两步桥接”的价值
            multiAnchorHubW: Math.max(32, Number(base.multiAnchorHubW||24) || 24),
            multiAnchorHub2W: Math.max(22, Number(base.multiAnchorHub2W||14) || 14),
            multiAnchorHubDepth: 2,
          }
        }

        const runOne = (wIdx)=> new Promise((resolve)=>{
          let w = null
          try { w = new Worker(new URL('./utils/solver-worker.js', import.meta.url), { type: 'module' }) } catch { return resolve(null) }
          workers.push(w)
          let done = false
          const finish = (payload)=>{
            if (done) return
            done = true
            try { w.terminate() } catch {}
            resolve(payload || null)
          }
          const logLine = (msg)=>{
            try {
              const now = Date.now()
              const line = `[${((now - startTs)/1000).toFixed(1)}s][opt-W${wIdx+1}] ${msg}`
              setProgressLogs(prev=>{
                const next = [...prev, line]
                return next.length > 400 ? next.slice(next.length - 400) : next
              })
            } catch {}
          }
          w.onmessage = (ev)=>{
            const { type, payload } = ev.data || {}
            if (type === 'progress') {
              const now = Date.now()
              if (now - progressLastRef.current > 250) {
                const phase = payload?.phase || 'optimize'
                setStatus(`计算中… ${phase}`)
                setSolveProgress({ phase, elapsedMs: now - startTs })
                progressLastRef.current = now
              }
              // 记录更细的日志（不做强节流，方便排查卡住在哪）
              try { logLine(`phase=${payload?.phase||'optimize'} len=${payload?.len??payload?.optimizedLen??'-'} crit=${payload?.criticalCount??'-'} reason=${payload?.reason??'-'}`) } catch {}
            } else if (type === 'result') {
              finish(payload)
            }
          }
          w.onerror = (e)=>{
            try { logLine(`error=${String(e?.message||e)}`) } catch {}
            finish(null)
          }
          w.onmessageerror = (e)=>{
            try { logLine(`messageerror=${String(e?.message||e)}`) } catch {}
            finish(null)
          }
          try { w.postMessage({ type:'set_flags', flags: mkOptFlags(wIdx) }) } catch {}
          try { w.postMessage({ type:'optimize', triangles: lightTris, palette, startId: sid, path: originalPath }) } catch { finish(null) }
          // 兜底超时
          setTimeout(()=>{ try { logLine('timeout') } catch {}; finish(null) }, hardTimeout + 5000)
        })

        const payloads = await Promise.all(Array.from({ length: PAR_N }, (_,i)=>runOne(i)))
        for (const p of payloads) { if (p) results.push(p) }
        // 选最短且统一的结果
        const candidates = results
          .filter(r=>Array.isArray(r.optimizedPath) && Number.isFinite(r.optimizedLen))
          .map(r=>{
            const ok = verifyUnifiedPath({ triangles, startId: (r.bestStartId ?? sid), path: r.optimizedPath })
            return { ...r, ok }
          })
          .filter(x=>x.ok)
        candidates.sort((a,b)=> (a.optimizedLen - b.optimizedLen) || ((b.shortened?1:0)-(a.shortened?1:0)))
        result = candidates[0] || results[0] || null
        try { for (const w of workers) { try { w.terminate() } catch {} } } catch {}
      } catch (err) {
        console.warn('parallel optimize failed', err)
        result = null
      }

      if (!result) { setStatus('路径优化失败'); setSolveProgress(null); return }
      const isUniformOut = Array.isArray(result.optimizedPath)
        ? verifyUnifiedPath({ triangles, startId: (result.bestStartId ?? sid), path: result.optimizedPath })
        : false
      if (result.shortened && result.optimizedPath && result.optimizedLen < (originalPath?.length||Infinity) && isUniformOut){
        // 生成新的快照
        const SNAPSHOT_LIMIT = 40
        const snapshots = await buildStepSnapshots({ triangles, width: canvasRef.current.width, height: canvasRef.current.height, startId: (result.bestStartId ?? sid), path: result.optimizedPath, maxSnap: SNAPSHOT_LIMIT, includeInitial: true })
         setSteps([{ path: result.optimizedPath, images: snapshots }])
        setBestStartId(result.bestStartId ?? sid)
        setStatus(`路径优化成功：由 ${originalPath.length} 步缩短为 ${result.optimizedLen} 步（起点 #${result.bestStartId ?? sid}）`)
        // 合格解日志（优化后）：单独存入浏览器“求解日志库”，不随清除解缓存删除
        try {
          const lines = Array.isArray(progressLogsRef.current) ? progressLogsRef.current.slice(-800) : []
          await saveQualifiedSolveLog({
            graph_signature: graphSignature3,
            timestamp: Date.now(),
            min_steps: result.optimizedLen,
            best_start_id: (result.bestStartId ?? sid),
            winner: result?.__winner || null,
            summary: `QUALIFIED(optimize_path) len=${result.optimizedLen} start=${result.bestStartId ?? sid}`,
            flags: (function(){
              try {
                const f = window.SOLVER_FLAGS || {}
                return {
                  strictMode: !!f.strictMode,
                  strictParallelWorkers: f.strictParallelWorkers ?? null,
                  enableSATPlanner: !!f.enableSATPlanner,
                  enableRAGMacro: !!f.enableRAGMacro,
                  enableLearningPrioritizer: !!f.enableLearningPrioritizer,
                  heuristicName: f.heuristicName || null,
                  parallelWorkers: f.parallelWorkers ?? null,
                  mode: 'optimize_path',
                }
              } catch { return null }
            })(),
            lines,
          })
        } catch {}
        try { await saveCachedSolutionWithPuzzle(graphSignature3, { startId: (result.bestStartId ?? sid), paths: [result.optimizedPath], minSteps: result.optimizedLen }, makePuzzlePayload(triangles, palette), window.SOLVER_FLAGS) } catch {}
        try { await recordRunScore(graphSignature3, { run_id: __runId3, algo_name: (window.SOLVER_FLAGS?.heuristicName||'default'), min_steps: result.optimizedLen, best_start_id: result.bestStartId ?? sid, time_ms: Date.now() - solveStartRef.current, is_unified: true, quality: 'final', source: 'optimize_path', flags: window.SOLVER_FLAGS }) } catch {}
        try { contribRef.current.path_len_reduction += Math.max(0, (originalPath?.length||0) - result.optimizedLen) } catch {}
        try { await postLearnScore(graphSignature3, { run_id: __runId3, graph_signature: graphSignature3, is_unified: true, path_len: result.optimizedLen, algo_scores: (()=>{ const m = { lb_improve_total: contribRef.current.lb_improve_total||0, branch_pruned_count: contribRef.current.branch_pruned||0, expansion_saved_est: Math.max(0, (contribRef.current.enqueued||0)-(contribRef.current.expanded||0)), critical_hits: contribRef.current.critical_hits||0, path_len_reduction: contribRef.current.path_len_reduction||0 }; const w = { lb:0.35, prune:0.25, expand:0.25, critical:0.10, path:0.05 }; const denom = Math.max(1, m.lb_improve_total + m.branch_pruned_count + m.expansion_saved_est + m.critical_hits + m.path_len_reduction); const norm = { lb: m.lb_improve_total/denom, prune: m.branch_pruned_count/denom, expand: m.expansion_saved_est/denom, critical: m.critical_hits/denom, path: m.path_len_reduction/denom }; const f = window.SOLVER_FLAGS||{}; const mods = []; const add=(key, engaged)=>{ if(!engaged) return; const score=100*(w.lb*norm.lb + w.prune*norm.prune + w.expand*norm.expand + w.critical*norm.critical + w.path*norm.path); mods.push({ key, score, metrics: m })}; add('ucb_prioritizer', !!f.enableLearningPrioritizer); add('bridge_first', !!f.enableBridgeFirst); add('best_first', !!f.enableBestFirst); add('a_star_lb', !!f.useAStarInBestFirst || !!f.useStrongLBInBestFirst); add('beam_search', !!f.enableBeam); add('lookahead', !!f.enableLookahead || !!f.enableLookaheadDepth2); add('zero_expand_filter', !!f.enableZeroExpandFilter); add('pdb', !!f.enablePDBAutoLoad); add('local_repair', !!f.optimizeEnableWindow || !!f.optimizeEnableRemoval || (Number(f.optimizeSwapPasses)||0)>0 ); add('sat_planner', !!f.enableSATPlanner); return mods; })() }) } catch {}
        try { if(__runId3) await telemetryFinishRun(__runId3, { status:'finished', min_steps: result.optimizedLen, best_start_id: result.bestStartId ?? sid, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature3 }) } catch {}
        try { await uploadStrategyAuto(triangles, palette, 'optimize_path', (result.bestStartId ?? sid), result.optimizedPath, (result?.analysis?.critical||null)) } catch {}
      } else {
        setStatus('未发现更短且统一的路径（已完成关键节点分析，可查看日志）')
        // 仅用于调试展示（避免引用已删除函数）
        try { verifyUnifiedPath({ triangles, startId: sid, path: originalPath }) } catch {}
        
        try { if(__runId3) await telemetryFinishRun(__runId3, { status:'finished', min_steps: originalPath?.length, best_start_id: sid, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature3 }) } catch {}
        try { await uploadStrategyAuto(triangles, palette, 'optimize_path', sid, originalPath, (result?.analysis?.critical||null)) } catch {}
      }
      setSolveProgress(null)
    } catch (err) {
      console.error('Optimize path error:', err)
      setStatus('路径优化时发生错误')
      
      try { if(__runId3) await telemetryFinishRun(__runId3, { status:'error', error: String(err?.message||err), time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature3 }) } catch {}
    } finally {
      setSolving(false)
    }
  }, [steps, bestStartId, triangles, palette])

  // 进度窗口：自动滚动控制与复制/清空
  const [autoScroll, setAutoScroll] = useState(true)
  const onCopyLogs = useCallback(()=>{
    const flags = { ...(window.SOLVER_FLAGS||{}) }
    const meta = {
      stepLimit: maxStepsLimit,
      triangles: triangles?.length || 0,
      palette: palette?.length || 0,
      timestamp: new Date().toISOString(),
    }
    const header = `SOLVER_FLAGS=${JSON.stringify(flags)}\nMETA=${JSON.stringify(meta)}\n--- LOG ---\n`
    const text = header + progressLogs.join('\n')
    try { navigator.clipboard?.writeText(text); setStatus('已复制进度日志与参数到剪贴板') }
    catch { setStatus('复制失败，可手动选择文本复制') }
  }, [progressLogs, maxStepsLimit, triangles, palette])
  const onClearLogs = useCallback(()=>{ setProgressLogs([]); setStatus('已清空进度日志') }, [])

  const onOpenSolveLogs = useCallback(async ()=>{
    try {
      const list = await listQualifiedSolveLogs(80)
      setQualifiedLogs(Array.isArray(list) ? list : [])
      setSelectedQualifiedLog(null)
      setShowSolveLogModal(true)
      setStatus(`已加载求解日志：${Array.isArray(list) ? list.length : 0} 条`)
    } catch (e) {
      setStatus(`读取求解日志失败：${String(e?.message||e).slice(0,120)}`)
    }
  }, [])

  const onClearSolutionCacheOnly = useCallback(async ()=>{
    try {
      const ok = window.confirm('确认清除“题目+合格解”的浏览器缓存（IndexedDB）？\n说明：这不会删除后端数据库缓存；也不会清除“合格解策略记录/求解日志”。')
      if (!ok) return
      const res = await clearAllCachedSolutionsLocal()
      setStatus(`已清除解缓存：ok=${res?.ok??false} deleted=${res?.deleted ?? 'unknown'}（求解日志未清除）`)
    } catch (e) {
      setStatus(`清除解缓存失败：${String(e?.message||e).slice(0,120)}`)
    }
  }, [])
  // 日志窗口自动滚动到最新（可关闭）
  useEffect(()=>{
    if (!autoScroll) return
    const el = progressLogRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [progressLogs, autoScroll])

  // 导出：保存后的网格图导出为 PNG
  const onExportGrid = useCallback(() => {
    try {
      if (!canvasRef.current) { setStatus('当前画布不可用，无法导出'); return }
      if (editMode) { setStatus('请先保存编辑，再导出网格图'); return }
      if (!triangles || triangles.length === 0) { setStatus('当前无内容可导出'); return }
      // 直接导出当前画布内容（已绘制删除/透明过滤）
      const url = canvasRef.current.toDataURL('image/png')
      const a = document.createElement('a')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      a.href = url
      a.download = `grid-${ts}.png`
      a.click()
      setStatus('已导出网格图（PNG）')
    } catch (err) {
      console.error('Export error:', err)
      setStatus('导出失败，请重试')
    }
  }, [editMode, triangles])

  // 构建工程快照（JSON）
  const buildProjectSnapshot = useCallback(() => {
    return {
      version: 1,
      triangleSize,
      rotation,
      editMode,
      palette,
      selectedColor,
      startId,
      selectedIds,
      grid,
      triangles,
    }
  }, [triangleSize, rotation, editMode, palette, selectedColor, startId, selectedIds, grid, triangles])

  // 导出工程（JSON）：无损保存状态，避免重复识别
  const onExportProject = useCallback(() => {
    try {
      if (!grid || !triangles || triangles.length===0) { setStatus('当前无内容可导出工程'); return }
      const snapshot = buildProjectSnapshot()
      const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      a.href = url
      a.download = `project-${ts}.json`
      a.click()
      URL.revokeObjectURL(url)
      setStatus('已导出工程（JSON），可用于无损恢复状态')
    } catch (err) {
      console.error('Export project error:', err)
      setStatus('导出工程失败，请重试')
    }
  }, [buildProjectSnapshot, grid, triangles])

  // 加载工程（JSON）：恢复导出时的状态
  const onImportProjectFile = useCallback(async (file) => {
    try {
      const text = await file.text()
      const obj = JSON.parse(text)
      if (!obj || obj.version!==1 || !obj.grid || !obj.triangles) {
        setStatus('工程文件无效或版本不兼容'); return
      }
      // 应用快照
      setImgBitmap(null)
      setLoadedProject(true)
      setTriangleSize(obj.triangleSize ?? triangleSize)
      setRotation(obj.rotation ?? rotation)
      setEditMode(!!obj.editMode)
      // palette 处理：可选择仅从导入的 triangles 反推画布用色
      let importedPalette = Array.isArray(obj.palette)? obj.palette : []
      if (importPaletteOnlyFromTriangles) {
        const freq = colorFrequency(obj.triangles || [])
        importedPalette = [...freq.keys()].sort((a,b)=> (freq.get(b)||0) - (freq.get(a)||0))
      }
      setPalette(importedPalette)
      try { localStorage.setItem('palette', JSON.stringify(importedPalette)) } catch {}
      setSelectedColor(importedPalette.includes(obj.selectedColor) ? obj.selectedColor : (importedPalette[0] ?? null))
      setStartId(obj.startId ?? null)
      setSelectedIds(Array.isArray(obj.selectedIds)? obj.selectedIds : [])
      setGrid(obj.grid)
      setTriangles(obj.triangles)
      setUndoStack([obj.triangles.map(t=>t.color)])
      setRedoStack([])
      setSteps([])
      setStatus('已加载工程快照，状态已复现，无需重新识别')
    } catch (err) {
      console.error('Import project error:', err)
      setStatus('导入工程失败，请检查文件或重试')
    }
  }, [triangleSize, rotation, importPaletteOnlyFromTriangles])

  // 框选：开始
  const onDragStart = useCallback((pt, e) => {
    if (e?.button !== 0) return
    setIsDragging(true)
    setDragStart(pt)
    setLassoClosed(false)
    setLassoPath([pt])
    setDragRect(null)
    setStatus('套索：拖拽以闭合选择')
  }, [])

  // 框选：移动
  const onDragMove = useCallback((pt, e) => {
    if (!isDragging || !dragStart) return
    setLassoPath(prev => {
      const last = prev[prev.length - 1]
      const dx = pt.x - last.x
      const dy = pt.y - last.y
      const dist2 = dx*dx + dy*dy
      if (dist2 >= LASSO_MIN_DIST * LASSO_MIN_DIST) return [...prev, pt]
      return prev
    })
  }, [isDragging, dragStart])

  // 框选：结束并选中矩形内三角形（按质心）
  const onDragEnd = useCallback((pt, e) => {
    if (!isDragging || !dragStart) return
    setIsDragging(false)
    // 闭合判定：终点与起点距离
    const start = dragStart
    const dx = pt.x - start.x
    const dy = pt.y - start.y
    // 补上释放点，确保轨迹包含终点
    let path = lassoPath
    if (path && path.length) {
      const last = path[path.length - 1]
      const ddx = pt.x - last.x
      const ddy = pt.y - last.y
      if ((ddx*ddx + ddy*ddy) >= (LASSO_MIN_DIST * LASSO_MIN_DIST)) {
        path = [...path, pt]
      }
    }
    // 按你的习惯：右键点击作为“确认闭合”动作
    const isRightClick = e?.button === 2
    const closed = isRightClick && ((path?.length || 0) >= 3)
    if (closed) {
      path = [...path, start]
      setLassoPath(path)
      setLassoClosed(true)
    }

    // 仅对闭合路径执行选择
    const pointInPolygon = (p, verts) => {
      let inside = false
      for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
        const xi = verts[i].x, yi = verts[i].y
        const xj = verts[j].x, yj = verts[j].y
        const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-9) + xi)
        if (intersect) inside = !inside
      }
      return inside
    }
    const bbox = (verts) => {
      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity
      for (const v of verts) { if (v.x<minX)minX=v.x; if(v.y<minY)minY=v.y; if(v.x>maxX)maxX=v.x; if(v.y>maxY)maxY=v.y }
      return { minX, minY, maxX, maxY }
    }
    const boxesOverlap = (b1, b2) => !(b1.maxX < b2.minX || b2.maxX < b1.minX || b1.maxY < b2.minY || b2.maxY < b1.minY)
    const lbox = closed ? bbox(path) : { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }

    const samplePointsInPolygon = (verts, count) => {
      const b = bbox(verts)
      const target = Math.max(3, count)
      let stepX = Math.max(1, (b.maxX - b.minX) / Math.ceil(Math.sqrt(target)))
      let stepY = Math.max(1, (b.maxY - b.minY) / Math.ceil(Math.sqrt(target)))
      const pts = []
      for (let y = b.minY; y <= b.maxY && pts.length < target; y += stepY) {
        for (let x = b.minX; x <= b.maxX && pts.length < target; x += stepX) {
          const p = { x, y }
          if (pointInPolygon(p, verts)) pts.push(p)
        }
      }
      // 若采样过少，使用质心与顶点补充
      if (pts.length < 3) {
        const cx = verts.reduce((s,v)=>s+v.x,0)/verts.length
        const cy = verts.reduce((s,v)=>s+v.y,0)/verts.length
        pts.push({x:cx,y:cy})
        for (let i=0;i<verts.length && pts.length<target;i++) pts.push(verts[i])
      }
      return pts
    }

    let ids = []
    if (closed) {
      ids = triangles
        .filter(t => !t.deleted && t.color!=='transparent')
        .filter(t => {
          const verts = (t.drawVertices && t.drawVertices.length>=3) ? t.drawVertices : t.vertices
          const tb = bbox(verts)
          if (!boxesOverlap(tb, lbox)) return false
          const samples = samplePointsInPolygon(verts, LASSO_SAMPLE_COUNT)
          let inside = 0
          for (const p of samples) { if (pointInPolygon(p, path)) inside++ }
          const cover = inside / (samples.length || 1)
          return cover >= LASSO_THRESHOLD
        })
        .map(t => t.id)
    }

    if (closed) {
      setSelectedIds(ids)
      setStartId(ids[0] ?? null)
      setStatus(`套索选择：${ids.length} 个（覆盖阈值≥${Math.round(LASSO_THRESHOLD*100)}%）`)
    } else {
      setStatus('套索未闭合（左键松开为取消；右键点击确认）')
    }
    setDragStart(null)
    setDragRect(null)
    // 清理轨迹（保留一帧由渲染显示闭合），随后清空
    setTimeout(() => { setLassoPath([]); setLassoClosed(false) }, 0)
  }, [isDragging, dragStart, triangles, lassoPath])

  const onDeleteSelected = useCallback(() => {
    if (!editMode) { setStatus('当前为试玩模式，如需删除请进入编辑模式'); return }
    if (selectedIds.length === 0) { setStatus('请先选择一个或多个三角形'); return }
    const toDelete = new Set(selectedIds)
    const next = triangles.map(t => toDelete.has(t.id) ? { ...t, deleted: true, color: 'transparent' } : t)
    setTriangles(next)
    setSelectedIds([])
    setStartId(null)
    // 记录颜色快照与删除步骤
    setUndoStack(prev => {
      const appended = [...prev, next.map(t => t.color)]
      return appended.length > 5 ? appended.slice(appended.length - 5) : appended
    })
    setRedoStack([])
    setHistoryStack(prev => {
      const appended = [...prev, { type: 'delete', ids: [...toDelete] }]
      return appended.length > 5 ? appended.slice(appended.length - 5) : appended
    })
    setHistoryRedoStack([])
    setStatus(`已删除 ${toDelete.size} 个三角形`)
  }, [editMode, selectedIds, triangles])

  const onSaveEdit = useCallback(() => {
    if (!grid || triangles.length === 0) { setStatus('当前无内容可保存'); return }
    const snapshotColors = triangles.map(t => t.color)
    const deletedIds = triangles.filter(t => t.deleted).map(t => t.id)
    setUndoStack([snapshotColors])
    setRedoStack([])
    setHistoryStack([])
    setHistoryRedoStack([])
    setInitialPalette(palette)
    setInitialSelectedColor(selectedColor || null)
    setInitialDeletedIds(deletedIds)
    setEditMode(false)
    setStatus('已保存编辑为存档点：撤销/重做将回到此状态')

    // 保存后异步生成色块统计与编号快照（避免阻塞 UI）
    try {
      setRegionStatsReady(false)
      setRegionStatsComputing(true)
      const trisSnap = triangles.map(t=>({ ...t }))
      const gridSnap = { ...grid }
      const rotSnap = rotation
      setTimeout(() => {
        try {
          const stats = computeRegionStats(trisSnap)
          const png = renderRegionStatsSnapshotPNG({ grid: gridSnap, triangles: trisSnap, rotation: rotSnap, regionStats: stats })
          setRegionStats(stats)
          setRegionStatsPng(png)
          setRegionStatsReady(true)
        } catch (e) {
          console.warn('region stats failed', e)
          setRegionStats(null)
          setRegionStatsPng(null)
          setRegionStatsReady(false)
        } finally {
          setRegionStatsComputing(false)
        }
      }, 30)
    } catch {}
  }, [grid, triangles, palette, selectedColor])

  // 随时重算色块统计（用于代码更新/调参后验证评分变化）
  const recomputeRegionStats = useCallback(() => {
    if (!grid || !Array.isArray(triangles) || triangles.length === 0) return
    try {
      setRegionStatsReady(false)
      setRegionStatsComputing(true)
      const trisSnap = triangles.map(t=>({ ...t }))
      const gridSnap = { ...grid }
      const rotSnap = rotation
      setTimeout(() => {
        try {
          const stats = computeRegionStats(trisSnap)
          const png = renderRegionStatsSnapshotPNG({ grid: gridSnap, triangles: trisSnap, rotation: rotSnap, regionStats: stats })
          setRegionStats(stats)
          setRegionStatsPng(png)
          setRegionStatsReady(true)
        } catch (e) {
          console.warn('region stats failed', e)
          setRegionStats(null)
          setRegionStatsPng(null)
          setRegionStatsReady(false)
        } finally {
          setRegionStatsComputing(false)
        }
      }, 30)
    } catch {}
  }, [grid, triangles, rotation])

  // 编辑期间实时统计色块数量（节流）
  useEffect(() => {
    if (!grid || !Array.isArray(triangles) || triangles.length === 0) { setRegionCountLive(null); return }
    let timer = null
    timer = setTimeout(() => {
      try {
        const stats = computeRegionStats(triangles)
        setRegionCountLive(stats?.count ?? null)
      } catch {
        setRegionCountLive(null)
      }
    }, 220)
    return () => { try { if (timer) clearTimeout(timer) } catch {} }
  }, [grid, triangles, editMode, rotation])

  const onEnterEdit = useCallback(() => {
    setEditMode(true)
    setStatus('已进入编辑模式：可泼涂或删除三角形')
  }, [])

  // 支持 Esc 取消当前套索并清空轨迹
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setIsDragging(false)
        setDragStart(null)
        setDragRect(null)
        setLassoPath([])
        setLassoClosed(false)
        setStatus('已取消套索')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 调色板允许包含“尚未出现在画布上的颜色”，避免添加后立刻被改回
  // 因此不再强制将 selectedColor 改为画布中存在的颜色
  useEffect(() => {
    if (!palette || palette.length===0) return
    // 保留占位以便未来扩展（例如统计使用情况），当前不改动 selectedColor
  }, [triangles, palette])

  // 说明子页渲染（含返回按钮在组件内部）
  if (route === '#/help') {
    return (
      <>
        <a href="#" className="help-link" style={{ position:'fixed', top:'12px', right:'16px', color:'var(--muted)', textDecoration:'none' }}>返回主页</a>
        <HelpPage />
      </>
    )
  }


  // 管理子页渲染：后台数据列表与事件
  if (route === '#/admin') {
    if (!hubAuthed) {
      const onSubmit = async () => {
        const pwd = (hubPwd||'').trim()
        if (!pwd) { alert('请输入密码'); return }
        try {
          const base = (typeof window!=='undefined' && window.SOLVER_FLAGS?.serverBaseUrl) ? String(window.SOLVER_FLAGS.serverBaseUrl) : (typeof window!=='undefined' ? (window.location.origin || 'http://localhost:3001') : 'http://localhost:3001')
          const res = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ password: pwd }) })
          if (!res.ok) { throw new Error('unauthorized') }
          const data = await res.json()
          const token = String(data?.token||'')
          if (!token) throw new Error('no_token')
          try { localStorage.setItem('adminToken', token) } catch {}
          try { window.ADMIN_TOKEN = token } catch {}
          try { sessionStorage.setItem('hubAuthed', '1') } catch {}
          setHubAuthed(true)
        } catch (e) {
          alert('无权限或后端未启动')
          try { window.location.hash = '#/help' } catch { window.location.hash = '#/help' }
        }
      }
      const onCancel = () => { try { window.location.hash = '#/help' } catch { window.location.hash = '#/help' } }
      const onKeyDown = (e) => { if (e.key === 'Enter') onSubmit() }
      return (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
          <div className="panel" style={{ width:'360px', background:'var(--panel)', padding:'16px', boxShadow:'0 6px 24px rgba(0,0,0,.2)' }}>
            <h3 style={{ margin:'0 0 12px 0', fontSize:'15px', color:'var(--muted)' }}>请输入密码</h3>
            <input type="password" value={hubPwd} onChange={e=>setHubPwd(e.target.value)} onKeyDown={onKeyDown} placeholder="密码" style={{ width:'100%', padding:'8px', border:'1px solid var(--panel-border)', borderRadius:4, marginBottom:'12px', background:'var(--bg)' }} />
            <div style={{ display:'flex', gap:'8px', justifyContent:'flex-end' }}>
              <button onClick={onCancel}>取消</button>
              <button className="primary" onClick={onSubmit}>确认</button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <>
        <a href="#/help" className="help-link" style={{ position:'fixed', top:'12px', right:'16px', color:'var(--muted)', textDecoration:'none' }}>说明</a>
        <AdminDashboard />
      </>
    )
  }

  return (
    <div className="app">
      <div className="panel upload">
        <h2>上传图片 / 截图</h2>
        <UploadPanel onImage={handleImage} targetColorCount={targetColorCount} setTargetColorCount={setTargetColorCount} />
        <div className="status">{status}</div>
      </div>

      {/* 顶部右上角说明入口 */}
      <a href="#/help" className="help-link" style={{ position:'fixed', top:'12px', right:'16px', color:'var(--muted)', textDecoration:'none' }}>说明</a>

      <div className="panel">
        <h2>画布</h2>
        <div
          className="canvas-wrap"
          ref={canvasWrapRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* 
             缩放容器：
             1. 显式设置宽高，撑开父容器的滚动条
             2. 内置 TriangleCanvas 使用 scale 进行渲染
             3. 注意处理旋转导致的宽高互换
          */}
          <div style={{
             width: (rotation===90||rotation===270 ? (grid?.height||0) : (grid?.width||0)) * canvasScale,
             height: (rotation===90||rotation===270 ? (grid?.width||0) : (grid?.height||0)) * canvasScale,
             // 保证内容居中（当小于视口时）
             // 移除 flexShrink，使用 margin: auto 在 block 布局下实现居中
             margin: 'auto'
          }}>
            <div style={{ 
               width: '100%', 
               height: '100%', 
               transformOrigin: '0 0',
               transform: `scale(${canvasScale})` 
            }}>
              <TriangleCanvas
                key={rotation}
                ref={canvasRef}
                grid={grid}
                triangles={triangles}
                onClickTriangle={onClickTriangle}
                selectedIds={selectedIds}
                rotation={rotation}
                selectionRect={dragRect}
                lassoPath={lassoPath}
                lassoClosed={lassoClosed}
                onDragStart={onDragStart}
                onDragMove={onDragMove}
                onDragEnd={onDragEnd}
              />
            </div>
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: '.75rem' }}>
          <button className="primary" onClick={onPaint} disabled={!selectedColor || startId==null}>泼涂</button>
          <button onClick={onUndo}>撤销</button>
          <button onClick={onRedo}>重做</button>
          <button onClick={onSelectSameColor} disabled={triangles.length===0}>选择同色</button>
          <button onClick={onBulkReplaceToSelected} disabled={!selectedColor || selectedIds.length===0}>批量替换为选色</button>
          <button onClick={onSolve} disabled={solving || triangles.length===0}>{solving ? '计算中…' : '自动求解'}</button>
          <span style={{ marginLeft: '.25rem', fontSize:'12px', color:'#7f8aa8' }}>
            色块：{regionCountLive==null ? '-' : regionCountLive}
          </span>
          <span style={{ marginLeft: '.5rem', display:'inline-flex', alignItems:'center', gap:'.25rem', color:'#a9b3c9' }}>
            <label htmlFor="stepLimit">步数上限</label>
            <input
              id="stepLimit"
              type="number"
              min={1}
              max={200}
              value={maxStepsLimit ?? ''}
              onChange={(e)=>{
                const str = e.target.value
                if (str === '' || str == null) { setMaxStepsLimit(null); return }
                const v = parseInt(str, 10)
                setMaxStepsLimit(Number.isFinite(v) ? Math.max(1, Math.min(200, v)) : null)
              }}
              style={{ width:'64px', padding:'2px 6px', borderRadius:'6px', border:'1px solid var(--border)', background:'#1a1f2b', color:'var(--text)' }}
              title="自动求解最多执行的步骤数量（留空表示不限制）"
            />
          </span>
          {editMode ? (
            <>
              <button onClick={onDeleteSelected} disabled={selectedIds.length===0}>删除选中（{selectedIds.length}）</button>
              <button onClick={onSaveEdit}>保存编辑</button>
            </>
          ) : (
            <>
              <button onClick={onEnterEdit}>进入编辑</button>
              {regionStatsComputing ? (
                <button disabled title="正在统计色块与评分…">统计中…</button>
              ) : regionStatsReady ? (
                <button onClick={()=>setShowRegionStats(true)}>查看统计信息（{regionStats?.count ?? 0}）</button>
              ) : (
                <button disabled title="请先点击“保存编辑”，统计完成后即可查看">查看统计信息</button>
              )}
            </>
          )}
        </div>
        <div style={{ marginTop: '.5rem', padding: '.5rem', border: '1px solid var(--border)', borderRadius: '8px', background: '#121826' }}>
          <div style={{ color: '#a9b3c9', marginBottom: '.25rem', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span>计算进度{!solving && '（空闲）'}</span>
            <span style={{ display:'inline-flex', gap:'6px', alignItems:'center' }}>
              <button onClick={onCopyLogs} className="small-btn" style={{ fontSize:'12px' }}>复制日志</button>
              <button onClick={onClearLogs} className="small-btn" style={{ fontSize:'12px' }}>清空</button>
              <label style={{ fontSize:'12px', color:'#7f8aa8' }}>
                <input type="checkbox" checked={autoScroll} onChange={e=>setAutoScroll(!!e.target.checked)} style={{ marginRight:'4px' }} />自动滚动
              </label>
              {typeof solveProgress?.elapsedMs==='number' && <span style={{ fontSize:'12px', color:'#7f8aa8' }}>耗时 {Math.round(solveProgress.elapsedMs/1000)}s</span>}
            </span>
          </div>
          {/* 顶部统计信息 */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:'8px', fontSize:'12px', marginBottom: '.5rem' }}>
            {solveProgress?.phase && <span>阶段：{solveProgress.phase}</span>}
            {typeof solveProgress?.nodes==='number' && <span>探索节点：{solveProgress.nodes}</span>}
            {typeof solveProgress?.queue==='number' && <span>队列：{solveProgress.queue}</span>}
            {typeof solveProgress?.solutions==='number' && <span>候选分支：{solveProgress.solutions}</span>}
            {typeof solveProgress?.components==='number' && <span>分量数：{solveProgress.components}</span>}
            {solveProgress?.bestStartId!=null && <span>当前最优起点：#{solveProgress.bestStartId}</span>}
            {typeof solveProgress?.minSteps==='number' && <span>当前最少步骤：{solveProgress.minSteps}</span>}
            {typeof solveProgress?.perf?.enqueued==='number' && <span>入队：{solveProgress.perf.enqueued}</span>}
            {typeof solveProgress?.perf?.expanded==='number' && <span>扩张：{solveProgress.perf.expanded}</span>}
            {typeof solveProgress?.perf?.filteredZero==='number' && <span>零扩张过滤：{solveProgress.perf.filteredZero}</span>}
          </div>
          {/* 滚动日志窗口 */}
          <div ref={progressLogRef} style={{ height:'160px', overflowY:'auto', background:'#0f1420', border:'1px solid var(--border)', borderRadius:'6px', padding:'6px' }}>
            <pre style={{ margin:0, whiteSpace:'pre-wrap', fontFamily:'Consolas, Menlo, monospace', fontSize:'12px', color:'#a9b3c9' }}>
              {progressLogs.map((l, i)=> (<div key={i}>{l}</div>))}
            </pre>
          </div>
        </div>
        {isUniform(triangles) && triangles.length>0 && (
          <div className="success">成功！画布统一为一种颜色</div>
        )}
      </div>

      <div className="panel controls">
        <h2>控制</h2>
        <Controls
          palette={palette}
          selectedColor={selectedColor}
          onSelectColor={setSelectedColor}
          onStartAddColorPick={onStartAddColorPick}
          pickMode={pickMode}
          onAddColorFromPicker={onAddColorFromPicker}
          onCancelPick={onCancelPick}
          onCleanPalette={onCleanPaletteToCanvasColors}
          onAiRectify={onAiRectify}
          onExportAiDebug={onExportAiDebug}
          canExportAiDebug={!!aiSegmentationMap}
          onExportGridDebug={onExportGridDebug}
        />
        <div className="grid-controls">
          <div className="row">
            <label>三角形尺寸</label>
            <input
              type="range"
              min="6"
              max="60"
              value={triangleSize}
              onChange={e=>setTriangleSize(+e.target.value)}
              disabled={!editMode || loadedProject}
              title={!editMode ? '当前为试玩模式：尺寸调整被暂停以保护已涂色内容'
                : loadedProject ? '当前为导入工程：为保持一致性暂不支持调整尺寸'
                : '调整三角形尺寸'}
            />
            <span>{triangleSize}px</span>
            {(!editMode || loadedProject) && (
              <span style={{ marginLeft: '.4rem', color: 'var(--muted)' }}>
                {loadedProject ? '导入工程状态下尺寸不可改' : '试玩模式下尺寸不可改'}
              </span>
            )}
          </div>
          <div className="row">
            <label>画布缩放</label>
            <input
              type="range"
              min="0.1"
              max="4"
              step="0.05"
              value={canvasScale}
              onChange={e=>{ const v=+e.target.value; setCanvasScale(Number.isFinite(v)? v : 1) }}
            />
            <span>{Math.round(canvasScale*100)}%</span>
          </div>
          <div className="row">
            <label>视图</label>
            <button onClick={centerView} title="按当前缩放居中画布">居中视图</button>
          </div>
          <div className="row">
            <label>网格排列</label>
            <button onClick={()=>setGridArrangement(a=> (a==='horizontal'?'vertical':'horizontal'))} title="只改变网格排列方向，不改变识别图形方向">
              {gridArrangement==='horizontal' ? '切到竖直排列' : '切到水平排列'}
            </button>
          </div>
          <div className="row">
            <label>图形旋转</label>
            <button onClick={onRotate90} title="顺时针旋转视图 90°（网格与图形一起）">旋转90°</button>
          </div>
          <div className="row">
            <label>颜色分离强度</label>
            <input type="range" min="0" max="10" value={colorSeparation} onChange={e=>setColorSeparation(+e.target.value)} />
            <span>{colorSeparation}</span>
          </div>
          <div className="row" style={{ marginTop: '.25rem' }}>
            <label>导出</label>
            <button onClick={onExportGrid} disabled={editMode || triangles.length===0}>导出网格图（PNG）</button>
          </div>
          <div className="row" style={{ marginTop: '.25rem' }}>
            <label>工程</label>
            <button onClick={onExportProject} disabled={!grid || triangles.length===0}>导出工程（JSON）</button>
            <button onClick={()=>importRef.current?.click()} style={{ marginLeft: '.5rem' }}>导入工程（JSON）</button>
            <input ref={importRef} type="file" accept="application/json" style={{ display:'none' }} onChange={e=>{
              const f=e.target.files?.[0]; if(f) onImportProjectFile(f)
              e.target.value=''
            }} />
          </div>
          <div className="row" style={{ marginTop: '.25rem' }}>
            <label>调试</label>
            <button onClick={onOpenSolveLogs} title="查看“合格解”产生时的策略/模块参与与关键日志（独立存储，不随清除解缓存删除）">查看求解日志</button>
            <button onClick={onClearSolutionCacheOnly} style={{ marginLeft: '.5rem' }} title="只清除题目+合格解缓存（IndexedDB solutions），不会删除求解日志/策略记录">清除解缓存</button>
          </div>
          <div className="row" style={{ marginTop: '.25rem' }}>
            <label>导入选项</label>
            <label style={{ display:'inline-flex', alignItems:'center', gap:'.35rem' }} title="开启后：导入时忽略快照中的调色板，只保留导入画布中出现的颜色">
              <input type="checkbox" checked={importPaletteOnlyFromTriangles} onChange={e=>setImportPaletteOnlyFromTriangles(e.target.checked)} />
              仅加载画布用色
            </label>
          </div>
        </div>

      </div>

      <div className="panel steps">
        <h2>方案步骤</h2>
        <div style={{ marginBottom: '.5rem' }}>
          <button onClick={onContinueShortest} disabled={solving || !steps || steps.length===0}>继续计算最短步骤</button>
          <button onClick={onOptimizePath} disabled={solving || !steps || steps.length===0} style={{ marginLeft:'8px' }}>路径优化（反思/压缩）</button>
        </div>
        <StepsPanel steps={steps} />
      </div>

      {/* 合格解求解日志弹窗：独立存储（不随“清除解缓存”删除） */}
      {showSolveLogModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.42)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div className="panel" style={{ width:'min(1100px, 92vw)', height:'min(86vh, 860px)', overflow:'hidden', background:'var(--panel)', display:'flex', flexDirection:'column' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px', padding:'12px 12px 8px 12px', borderBottom:'1px solid var(--border)' }}>
              <div style={{ display:'flex', flexDirection:'column' }}>
                <div style={{ fontSize:'14px', color:'var(--muted)' }}>求解日志（仅合格解）</div>
                <div style={{ fontSize:'12px', color:'#7f8aa8' }}>该日志库独立存储：清除“解缓存”不会影响这里的策略/模块记录。</div>
              </div>
              <div style={{ display:'inline-flex', gap:'8px', alignItems:'center' }}>
                <button
                  className="small-btn"
                  style={{ fontSize:'12px' }}
                  onClick={async ()=>{
                    try {
                      const list = await listQualifiedSolveLogs(80)
                      setQualifiedLogs(Array.isArray(list) ? list : [])
                      setSelectedQualifiedLog(null)
                      setStatus(`已刷新求解日志：${Array.isArray(list) ? list.length : 0} 条`)
                    } catch {}
                  }}
                  title="重新从浏览器日志库读取"
                >
                  刷新
                </button>
                <button onClick={()=>setShowSolveLogModal(false)} className="small-btn" style={{ fontSize:'12px' }}>关闭</button>
              </div>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'minmax(320px, 0.9fr) 1.1fr', gap:'12px', padding:'12px', overflow:'auto' }}>
              <div style={{ border:'1px solid var(--border)', borderRadius:'8px', background:'#0f1420', overflow:'auto' }}>
                <div style={{ padding:'10px 10px 6px 10px', fontSize:'12px', color:'#93a0b7', borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
                  共 {Array.isArray(qualifiedLogs) ? qualifiedLogs.length : 0} 条（最新在上）
                </div>
                <div>
                  {(Array.isArray(qualifiedLogs) ? qualifiedLogs : []).map((r)=> {
                    const t = r?.timestamp ? new Date(r.timestamp) : null
                    const timeStr = t ? `${t.toLocaleDateString()} ${t.toLocaleTimeString()}` : '-'
                    const win = r?.winner || {}
                    const winStr = (win && Number.isFinite(win.workerIndex)) ? `W${win.workerIndex+1}${win.group||''}` : '-'
                    const title = `${timeStr} | len=${r?.min_steps ?? '-'} | ${winStr} | ${String(r?.graph_signature||'').slice(0, 10)}…`
                    const active = (selectedQualifiedLog?.id && selectedQualifiedLog.id === r.id)
                    return (
                      <div
                        key={r.id}
                        onClick={async ()=>{
                          try {
                            const full = await getQualifiedSolveLog(r.id)
                            setSelectedQualifiedLog(full || r)
                          } catch {
                            setSelectedQualifiedLog(r)
                          }
                        }}
                        title={title}
                        style={{
                          padding:'10px',
                          borderBottom:'1px solid rgba(255,255,255,0.06)',
                          cursor:'pointer',
                          background: active ? 'rgba(120,160,255,0.10)' : 'transparent',
                        }}
                      >
                        <div style={{ display:'flex', justifyContent:'space-between', gap:'8px' }}>
                          <div style={{ fontSize:'12px', color:'#cbd3e1' }}>{timeStr}</div>
                          <div style={{ fontSize:'12px', color:'#93a0b7' }}>len={r?.min_steps ?? '-'}</div>
                        </div>
                        <div style={{ marginTop:'4px', fontSize:'12px', color:'#93a0b7', display:'flex', justifyContent:'space-between', gap:'8px' }}>
                          <span>{String(r?.graph_signature||'')}</span>
                          <span>{winStr}</span>
                        </div>
                        {r?.summary && <div style={{ marginTop:'4px', fontSize:'12px', color:'#7f8aa8' }}>{String(r.summary).slice(0, 120)}</div>}
                      </div>
                    )
                  })}
                  {(!Array.isArray(qualifiedLogs) || qualifiedLogs.length===0) && (
                    <div style={{ padding:'12px', color:'#93a0b7' }}>暂无记录（只有跑出合格解时才会写入）。</div>
                  )}
                </div>
              </div>

              <div style={{ border:'1px solid var(--border)', borderRadius:'8px', background:'#0f1420', overflow:'hidden', display:'flex', flexDirection:'column' }}>
                <div style={{ padding:'10px', borderBottom:'1px solid rgba(255,255,255,0.06)', display:'flex', justifyContent:'space-between', gap:'10px', alignItems:'center' }}>
                  <div style={{ fontSize:'12px', color:'#93a0b7' }}>
                    {selectedQualifiedLog ? `详情：${selectedQualifiedLog.id}` : '请选择一条日志查看详情'}
                  </div>
                  {selectedQualifiedLog && (
                    <div style={{ display:'inline-flex', gap:'8px', alignItems:'center' }}>
                      <button
                        className="small-btn"
                        style={{ fontSize:'12px' }}
                        onClick={async ()=>{
                          try {
                            const txt = (Array.isArray(selectedQualifiedLog?.lines) ? selectedQualifiedLog.lines : []).join('\n')
                            await navigator.clipboard.writeText(txt)
                            setStatus('已复制日志文本到剪贴板')
                          } catch {
                            setStatus('复制失败：浏览器可能禁止 clipboard')
                          }
                        }}
                      >
                        复制日志
                      </button>
                      <button
                        className="small-btn"
                        style={{ fontSize:'12px' }}
                        onClick={async ()=>{
                          try {
                            const ok = window.confirm('确认删除这条求解日志？\n注意：这只删除日志，不影响后端或解缓存。')
                            if (!ok) return
                            await deleteQualifiedSolveLog(selectedQualifiedLog.id)
                            const list = await listQualifiedSolveLogs(80)
                            setQualifiedLogs(Array.isArray(list) ? list : [])
                            setSelectedQualifiedLog(null)
                            setStatus('已删除该条求解日志')
                          } catch {}
                        }}
                        title="仅删除该条求解日志（用于调试整理）"
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ padding:'10px', overflow:'auto', fontSize:'12px', color:'#cbd3e1', whiteSpace:'pre-wrap' }}>
                  {selectedQualifiedLog ? (
                    <>
                      <div style={{ color:'#93a0b7', marginBottom:'8px' }}>
                        signature={selectedQualifiedLog.graph_signature || '-'}；min_steps={selectedQualifiedLog.min_steps ?? '-'}；best_start_id={selectedQualifiedLog.best_start_id ?? '-'}
                      </div>
                      <div style={{ color:'#93a0b7', marginBottom:'8px' }}>
                        winner={(() => {
                          const w = selectedQualifiedLog.winner || {}
                          const wStr = (w && Number.isFinite(w.workerIndex)) ? `W${w.workerIndex+1}${w.group||''}` : '-'
                          const pref = (w?.preferredStartId!=null) ? ` pref #${w.preferredStartId}` : ''
                          const strat = w?.strategy ? `；策略=${w.strategy}` : ''
                          const mods = w?.modules ? `；模块=${w.modules}` : ''
                          return `${wStr}${pref}${strat}${mods}`
                        })()}
                      </div>
                      <div style={{ color:'#93a0b7', marginBottom:'8px' }}>
                        flags={selectedQualifiedLog.flags ? JSON.stringify(selectedQualifiedLog.flags) : '-'}
                      </div>
                      <hr style={{ border:'none', borderTop:'1px solid rgba(255,255,255,0.06)', margin:'10px 0' }} />
                      {(Array.isArray(selectedQualifiedLog.lines) ? selectedQualifiedLog.lines : []).join('\n') || '（无日志行）'}
                    </>
                  ) : (
                    '（右侧显示选中日志的策略摘要与原始日志行）'
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 色块统计弹窗：编号快照 + 评分列表 */}
      {showRegionStats && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.42)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div className="panel" style={{ width:'min(1100px, 92vw)', height:'min(86vh, 860px)', overflow:'hidden', background:'var(--panel)', display:'flex', flexDirection:'column' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px', padding:'12px 12px 8px 12px', borderBottom:'1px solid var(--border)' }}>
              <div style={{ display:'flex', flexDirection:'column' }}>
                <div style={{ fontSize:'14px', color:'var(--muted)' }}>色块统计信息</div>
                <div style={{ fontSize:'12px', color:'#7f8aa8' }}>共 {regionStats?.count ?? 0} 个色块（编号=regionId+1）。评分=基础桥接分（边界/相邻/碎片度）+ hub-connector 两跳加成（同色桥梁+共同枢纽）。</div>
              </div>
              <div style={{ display:'inline-flex', gap:'8px', alignItems:'center' }}>
                <button onClick={recomputeRegionStats} disabled={regionStatsComputing} className="small-btn" style={{ fontSize:'12px' }} title="使用当前画布与最新评分逻辑重新计算">重新计算</button>
                <button onClick={()=>setShowRegionStats(false)} className="small-btn" style={{ fontSize:'12px' }}>关闭</button>
              </div>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'minmax(320px, 0.9fr) 1.1fr', gap:'12px', padding:'12px', overflow:'auto' }}>
              <div>
                <div style={{ fontSize:'12px', color:'#93a0b7', marginBottom:'6px' }}>编号快照（点击可另存）</div>
                {regionStatsPng ? (
                  <a href={regionStatsPng} download="region-stats.png" title="点击另存为 PNG">
                    <img src={regionStatsPng} alt="region stats" style={{ width:'100%', borderRadius:'8px', border:'1px solid var(--border)', background:'#0f1420' }} />
                  </a>
                ) : (
                  <div style={{ padding:'10px', border:'1px solid var(--border)', borderRadius:'8px', background:'#0f1420', color:'#93a0b7' }}>暂无快照</div>
                )}
              </div>

              <div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'6px' }}>
                  <div style={{ fontSize:'12px', color:'#93a0b7' }}>评分列表（默认按桥接评分降序）</div>
                </div>
                <div style={{ overflow:'auto', border:'1px solid var(--border)', borderRadius:'8px', background:'#0f1420' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px', color:'#cbd3e1' }}>
                    <thead>
                      <tr style={{ position:'sticky', top:0, background:'#0b1020', borderBottom:'1px solid var(--border)' }}>
                        <th style={{ textAlign:'left', padding:'8px' }}>编号</th>
                        <th style={{ textAlign:'left', padding:'8px' }}>颜色</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>大小</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>评分</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>基础分</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>两跳加成</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>加成(原始)</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>加成(缩放)</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>hub覆盖</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>hub权重</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>相邻色块</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>边界边</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>碎片度</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>死角</th>
                        <th style={{ textAlign:'right', padding:'8px' }}>距边</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const arr = Array.isArray(regionStats?.regions) ? [...regionStats.regions] : []
                        arr.sort((a,b)=> (b.score||0) - (a.score||0))
                        return arr.map(r => (
                          <tr key={r.regionId} style={{ borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
                            <td style={{ padding:'8px' }}>{r.regionId + 1}</td>
                            <td style={{ padding:'8px' }}>
                              <span style={{ display:'inline-flex', alignItems:'center', gap:'6px' }}>
                                <span style={{ width:'12px', height:'12px', borderRadius:'3px', background:r.color, border:'1px solid rgba(255,255,255,0.25)' }} />
                                <span style={{ color:'#93a0b7' }}>{r.color}</span>
                              </span>
                            </td>
                            <td style={{ padding:'8px', textAlign:'right' }}>{r.size}</td>
                            <td style={{ padding:'8px', textAlign:'right' }}>{Number.isFinite(r.score) ? r.score.toFixed(2) : '-'}</td>
                            <td style={{ padding:'8px', textAlign:'right', color:'#93a0b7' }}>{Number.isFinite(r.scoreBase) ? r.scoreBase.toFixed(2) : '-'}</td>
                            <td style={{ padding:'8px', textAlign:'right', color:'#93a0b7' }}>{Number.isFinite((r.score||0) - (r.scoreBase||0)) ? ((r.score||0) - (r.scoreBase||0)).toFixed(2) : '-'}</td>
                            <td style={{ padding:'8px', textAlign:'right', color:'#93a0b7' }}>{Number.isFinite(r.hubBonusRaw) ? r.hubBonusRaw.toFixed(1) : '-'}</td>
                            <td style={{ padding:'8px', textAlign:'right', color:'#93a0b7' }}>{Number.isFinite(r.hubBonusScaled) ? r.hubBonusScaled.toFixed(1) : '-'}</td>
                            <td style={{ padding:'8px', textAlign:'right', color:'#93a0b7' }}>{Number.isFinite(r.hubTouchCount) ? r.hubTouchCount : '-'}</td>
                            <td style={{ padding:'8px', textAlign:'right', color:'#93a0b7' }}>{Number.isFinite(r.hubTouchWeight) ? r.hubTouchWeight.toFixed(2) : '-'}</td>
                            <td style={{ padding:'8px', textAlign:'right' }}>{r.adjRegionCount}</td>
                            <td style={{ padding:'8px', textAlign:'right' }}>{r.boundaryEdges}</td>
                            <td style={{ padding:'8px', textAlign:'right' }}>{r.fragSum}</td>
                            <td style={{ padding:'8px', textAlign:'right' }}>{r.borderish}</td>
                            <td style={{ padding:'8px', textAlign:'right' }}>{Number.isFinite(r.avgDist) ? r.avgDist.toFixed(2) : '-'}</td>
                          </tr>
                        ))
                      })()}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop:'8px', fontSize:'12px', color:'#93a0b7' }}>
                  说明：相邻色块=与该色块边界直接接触的其他连通色块数量；两跳加成=“同色桥梁 + 共同枢纽 connector”把多个高评分 hub 串联的潜力；死角=该色块内邻居数&lt;3 的三角形数量（越大越贴边/越不适合作为起点）。
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
