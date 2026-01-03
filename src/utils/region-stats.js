// Region (connected color-block) statistics & labeled snapshot utilities.
// Goal: score/inspect concrete regions (not colors) for bridge potential.

function transformPoint(pt, grid, rotation) {
  const r = ((rotation % 360) + 360) % 360
  if (r === 90) return { x: grid.height - pt.y, y: pt.x }
  if (r === 180) return { x: grid.width - pt.x, y: grid.height - pt.y }
  if (r === 270) return { x: pt.y, y: grid.width - pt.x }
  return { x: pt.x, y: pt.y }
}

function isActiveTriangle(t) {
  return !!t && !t.deleted && t.color && t.color !== 'transparent'
}

export function computeRegions(triangles) {
  const n = triangles.length
  const idToIndex = new Map(triangles.map((t, i) => [t.id, i]))
  const regionOf = new Array(n).fill(-1)
  const regions = []

  for (let i = 0; i < n; i++) {
    const t0 = triangles[i]
    if (!isActiveTriangle(t0)) continue
    if (regionOf[i] !== -1) continue
    const color = t0.color
    const q = [t0.id]
    regionOf[i] = regions.length
    const indices = []
    while (q.length) {
      const id = q.shift()
      const idx = idToIndex.get(id)
      if (idx == null) continue
      if (regionOf[idx] !== regions.length) continue
      const t = triangles[idx]
      if (!isActiveTriangle(t) || t.color !== color) continue
      indices.push(idx)
      for (const nb of (t.neighbors || [])) {
        const nidx = idToIndex.get(nb)
        if (nidx == null) continue
        if (regionOf[nidx] !== -1) continue
        const tn = triangles[nidx]
        if (!isActiveTriangle(tn) || tn.color !== color) continue
        regionOf[nidx] = regions.length
        q.push(nb)
      }
    }
    if (indices.length) {
      regions.push({
        regionId: regions.length,
        color,
        size: indices.length,
        repId: triangles[indices[0]]?.id ?? null,
        indices,
      })
    }
  }

  return { regions, regionOf, idToIndex }
}

export function computeRegionStats(triangles) {
  const n = triangles.length
  const { regions, regionOf, idToIndex } = computeRegions(triangles)
  const neighbors = triangles.map(t => t.neighbors || [])

  // distToBorder: border defined by low degree (<3) on active graph
  const distToBorder = new Array(n).fill(Infinity)
  try {
    const q = []
    for (let i = 0; i < n; i++) {
      if (regionOf[i] === -1) continue
      const deg = neighbors[i].length
      if (deg < 3) { distToBorder[i] = 0; q.push(i) }
    }
    let qi = 0
    while (qi < q.length) {
      const u = q[qi++]
      const du = distToBorder[u]
      for (const nb of neighbors[u]) {
        const v = idToIndex.get(nb)
        if (v == null) continue
        if (regionOf[v] === -1) continue
        if (distToBorder[v] > du + 1) {
          distToBorder[v] = du + 1
          q.push(v)
        }
      }
    }
  } catch {}

  // region stats (base)
  const out = regions.map(r => {
    const adjRegions = new Set()
    const adjColors = new Set()
    const boundaryNodesByAdjRegion = new Map() // adjRegionId -> Set(nodeIndex)
    let boundaryEdges = 0
    let borderish = 0
    let distSum = 0
    let distCnt = 0
    let cx = 0, cy = 0, cCnt = 0

    for (const idx of r.indices) {
      const t = triangles[idx]
      const deg = neighbors[idx].length
      if (deg < 3) borderish++
      const d = distToBorder[idx]
      if (Number.isFinite(d)) { distSum += d; distCnt++ }
      const verts = (t.drawVertices && t.drawVertices.length >= 3) ? t.drawVertices : t.vertices
      if (verts && verts.length >= 3) {
        const px = (verts[0].x + verts[1].x + verts[2].x) / 3
        const py = (verts[0].y + verts[1].y + verts[2].y) / 3
        cx += px; cy += py; cCnt++
      }
      for (const nb of neighbors[idx]) {
        const j = idToIndex.get(nb)
        if (j == null) continue
        const rid2 = regionOf[j]
        if (rid2 === -1 || rid2 === r.regionId) continue
        boundaryEdges++
        adjRegions.add(rid2)
        const c2 = triangles[j]?.color
        if (c2 && c2 !== 'transparent') adjColors.add(c2)
        let set = boundaryNodesByAdjRegion.get(rid2)
        if (!set) { set = new Set(); boundaryNodesByAdjRegion.set(rid2, set) }
        set.add(j)
      }
    }

    // fragmentation: count connected components among boundary neighbor nodes, per adjacent region
    let fragSum = 0
    try {
      const MAX_BN = 800
      let processed = 0
      for (const [rid2, set] of boundaryNodesByAdjRegion.entries()) {
        if (processed >= MAX_BN) break
        const ids = Array.from(set)
        processed += ids.length
        const inSet = set
        const seen = new Set()
        let comps = 0
        for (const v of ids) {
          if (seen.has(v)) continue
          comps++
          const q = [v]; seen.add(v)
          while (q.length) {
            const u = q.shift()
            for (const nbId of neighbors[u] || []) {
              const w = idToIndex.get(nbId)
              if (w == null) continue
              if (!inSet.has(w) || seen.has(w)) continue
              seen.add(w); q.push(w)
            }
          }
          if (comps >= 14) break
        }
        fragSum += comps
      }
    } catch {}

    const avgDist = distCnt > 0 ? (distSum / distCnt) : 0
    const adjRegionCount = adjRegions.size
    const adjColorCount = adjColors.size

    // Bridge score（region-level）
    // 核心按“桥接/联通扩张价值”打分：
    // - 相邻色块数/相邻颜色种类越多越像枢纽
    // - 边界碎片度越高越容易用少量步骤撬动大范围联通
    // - 边界强度（边界边数）越高潜在操作面越大
    // 面积/贴边/中心仅作为极弱的 tie-break，避免误伤“贴边但收益高”的关键色块。
    // 基础桥接分：仅依赖“边界结构/相邻色块”，不显式看“同色桥梁/两跳结构”
    let scoreBase = (adjRegionCount * 26) + (adjColorCount * 8) + (fragSum * 6.0) + (boundaryEdges * 0.10)
    // 仅在桥接收益很低时才轻微考虑边缘/大块/贴边因素
    if (adjRegionCount <= 2 && fragSum <= 2) {
      scoreBase -= borderish * 0.8
      scoreBase -= Math.pow(r.size, 0.35) * 0.15
      if (avgDist < 0.9) scoreBase -= 2.0
    }

    return {
      regionId: r.regionId,
      repId: r.repId,
      color: r.color,
      size: r.size,
      scoreBase,
      // 最终 score 会在后续“hub-connector 两跳桥接”加成后更新
      score: scoreBase,
      adjRegionCount,
      adjColorCount,
      adjacentRegions: Array.from(adjRegions).sort((a, b) => a - b),
      adjacentColors: Array.from(adjColors),
      boundaryEdges,
      fragSum,
      borderish,
      avgDist,
      centroid: cCnt ? { x: cx / cCnt, y: cy / cCnt } : null,
    }
  })

  // --- hub-connector 两跳桥接增强评分 ---
  // 场景：像“52 同时邻接 48/49/56/57（同色）且它们分别触达多个 top hubs”，
  // 应把 connector 与同色桥梁的“串联价值”体现在评分上，以便统计页/锚点选择能看见它们。
  try {
    const HUB_TOPK = Math.max(2, Math.min(6, Math.floor(out.length / 8) || 6))
    const byRid = new Map(out.map(r => [r.regionId, r]))
    // 以基础分定义“hubs”，避免循环依赖
    const hubs = [...out].sort((a, b) => (b.scoreBase || 0) - (a.scoreBase || 0)).slice(0, HUB_TOPK)
    const hubSet = new Set(hubs.map(h => h.regionId))
    const hubWeight = new Map()
    {
      // hub 的“权重”用于区分：串联 4 个高分 hub > 串联 2 个低分 hub
      // 用 sqrt 压缩极端值，避免被单一超大 hub 垄断。
      for (const h of hubs) {
        const sb = Number(h?.scoreBase || 0)
        const w = Math.max(1, Math.sqrt(Math.max(0, sb)))
        hubWeight.set(h.regionId, w)
      }
    }
    // hub-adjacent：一跳邻接任意 hub 的区域
    const hubAdj = new Set()
    const hubAdjToHubs = new Map() // rid -> Set(hubRid)
    for (const r of out) {
      if (hubSet.has(r.regionId)) continue
      const adj = Array.isArray(r.adjacentRegions) ? r.adjacentRegions : []
      const hs = new Set()
      for (const rid2 of adj) if (hubSet.has(rid2)) hs.add(rid2)
      if (hs.size > 0) { hubAdj.add(r.regionId); hubAdjToHubs.set(r.regionId, hs) }
    }
    // 计算 connector：看它邻接的 hubAdj，按“邻接区域颜色”分组，挑出能串联 >=2 hubs 的组
    const connectorBonus = new Map() // rid -> number
    const memberBonus = new Map() // rid -> number
    const hubAdjBonus = new Map() // rid -> number (弱加成)
    const role = new Map() // rid -> { isHub?, isConnector?, isMember? }
    for (const h of hubs) { role.set(h.regionId, { ...(role.get(h.regionId) || {}), isHub: true }) }
    const sumHubW = (hsSet) => {
      let s = 0
      for (const hid of (hsSet || [])) s += (hubWeight.get(hid) || 0)
      return s
    }
    for (const r of out) {
      if (!hubAdj.has(r.regionId) && !hubSet.has(r.regionId)) {
        // 对普通非 hub 区域：若它本身 hubAdj（由上面标），给一点弱加成（更靠近 hub 的更可能是破局点）
        const hs = hubAdjToHubs.get(r.regionId)
        if (hs && hs.size > 0) {
          // 用“权重和”而不是“数量”区别接壤的是高分 hub 还是低分 hub
          const wsum = sumHubW(hs)
          hubAdjBonus.set(r.regionId, (hubAdjBonus.get(r.regionId) || 0) + wsum * 6)
          role.set(r.regionId, { ...(role.get(r.regionId) || {}), isHubAdj: true })
        }
      }
      const adj = Array.isArray(r.adjacentRegions) ? r.adjacentRegions : []
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
      let best = null
      let bestScore = -Infinity
      for (const [col, list] of groups.entries()) {
        if (!list || list.length < 2) continue
        const hubsUnion = new Set()
        for (const ridN of list) {
          const hs = hubAdjToHubs.get(ridN)
          if (hs) for (const h of hs) hubsUnion.add(h)
        }
        if (hubsUnion.size < 2) continue
        // connector 强度：要区分“串联的是哪些 hub”，所以用 hubWeightSum 作为主驱动
        const hubW = sumHubW(hubsUnion)
        // 二级：覆盖数与同色桥数量
        const s = (hubW * 120) + (hubsUnion.size * 35) + (list.length * 20) + (Number(r.scoreBase || 0) * 0.10)
        if (s > bestScore) { bestScore = s; best = { hubsCount: hubsUnion.size, hubW, members: list.slice() } }
      }
      if (!best) continue
      // connector 本体加成（强调“内部枢纽”）
      connectorBonus.set(r.regionId, (connectorBonus.get(r.regionId) || 0) + bestScore * 0.55)
      role.set(r.regionId, { ...(role.get(r.regionId) || {}), isConnector: true })
      // 记录 connector 的“可解释指标”，用于统计页对比（例如 52 vs 61/29/34）
      r.connectorHubCount = best.hubsCount
      r.connectorHubWeight = best.hubW
      r.connectorMemberCount = best.members.length
      // 同色桥梁成员加成（强调“内部动手点”）
      for (const ridN of best.members) {
        // 记录成员所属 connector 的“两跳强度”，供 internalBridgeOnly 线程仅按两跳分挑选 top3
        try {
          const rn2 = byRid.get(ridN)
          if (rn2) {
            rn2.memberConnectorHubWeight = Math.max(Number(rn2.memberConnectorHubWeight || 0), Number(best.hubW || 0))
            rn2.memberConnectorHubCount = Math.max(Number(rn2.memberConnectorHubCount || 0), Number(best.hubsCount || 0))
            rn2.memberConnectorMemberCount = Math.max(Number(rn2.memberConnectorMemberCount || 0), Number(best.members.length || 0))
          }
        } catch {}
        const hs = hubAdjToHubs.get(ridN)
        const hwLocal = hs ? sumHubW(hs) : 0
        // 成员加成：既看“它自己贴到的 hub 权重”，也看“它所在的 connector 串联强度”
        const mb = (hwLocal * 38) + (best.hubW * 14) + (best.hubsCount * 16)
        memberBonus.set(ridN, (memberBonus.get(ridN) || 0) + mb)
        role.set(ridN, { ...(role.get(ridN) || {}), isConnectorMember: true })
      }
    }
    for (const r of out) {
      const b1 = connectorBonus.get(r.regionId) || 0
      const b2 = memberBonus.get(r.regionId) || 0
      const b3 = hubAdjBonus.get(r.regionId) || 0
      const bonusTotal = b1 + b2 + b3
      // 对两跳加成做“比例缩放 + 相对封顶”，避免 connector 分数飙升到压过 hub
      // 关键目标：
      // 1) hub 的定义/排序主要由 scoreBase 决定（真正的结构枢纽）
      // 2) 两跳加成只用于“内部破局/细分优先级”，不应喧宾夺主
      // 可通过 window.SOLVER_FLAGS 调参：hubBonusScale / hubBonusCapFactor
      let hubMedianBase = 0
      try {
        const bases = hubs.map(h => Number(h?.scoreBase || 0)).filter(x => Number.isFinite(x)).sort((a,b)=>a-b)
        if (bases.length) hubMedianBase = bases[Math.floor(bases.length/2)]
      } catch {}
      const G = (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}))
      const flags = (G && G.SOLVER_FLAGS) ? G.SOLVER_FLAGS : {}
      const bonusScale = Number.isFinite(flags?.hubBonusScale) ? Math.max(0, flags.hubBonusScale) : 0.30
      const capFactor = Number.isFinite(flags?.hubBonusCapFactor) ? Math.max(0, flags.hubBonusCapFactor) : 0.85
      const capAbs = Math.max(0, hubMedianBase) * capFactor
      const bonusScaled = bonusTotal * bonusScale
      // 软封顶：避免“全部被同一个 cap 夹死导致加成一模一样”
      // y = cap * tanh(x/cap)：
      // - x 很小时近似线性（保留差异）
      // - x 很大时渐进到 cap（防止爆炸）
      const bonusApplied = (capAbs > 0)
        ? (capAbs * Math.tanh(bonusScaled / capAbs))
        : bonusScaled
      r.hubConnectorBonus = b1
      r.hubConnectorMemberBonus = b2
      r.hubAdjBonus = b3
      r.hubBonusRaw = bonusTotal
      r.hubBonusScaled = bonusScaled
      r.hubBonusApplied = bonusApplied
      // hub 相关解释字段：它一跳触达多少 hub、权重和多少（用于区分“接壤高分 hub vs 低分 hub”）
      const hs = hubAdjToHubs.get(r.regionId)
      r.hubTouchCount = hs ? hs.size : 0
      r.hubTouchWeight = hs ? sumHubW(hs) : 0
      const rr = role.get(r.regionId) || {}
      r.isHub = !!rr.isHub
      r.isConnector = !!rr.isConnector
      r.isConnectorMember = !!rr.isConnectorMember
      r.isHubAdj = !!rr.isHubAdj
      r.score = (r.scoreBase || 0) + bonusApplied
    }
  } catch {}

  // Stable order by regionId; caller can sort for display.
  out.sort((a, b) => a.regionId - b.regionId)
  return { count: out.length, regions: out }
}

export function renderRegionStatsSnapshotPNG({ grid, triangles, rotation = 0, regionStats }) {
  if (!grid || !Array.isArray(triangles) || !regionStats) return null
  const stats = regionStats.regions || []
  // 注意：顶点坐标可能存在轻微越界（浮点误差），且 grid.width/height 与实际顶点范围有时并不完全一致。
  // 为彻底避免“上边界缺三角形/锯齿裁剪”，这里完全以实际顶点 bbox 决定画布尺寸与平移（不依赖 grid 尺寸）。
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const t of triangles) {
    if (!isActiveTriangle(t)) continue
    const verts = (t.drawVertices && t.drawVertices.length >= 3) ? t.drawVertices : t.vertices
    if (!verts || verts.length < 3) continue
    for (let i = 0; i < 3; i++) {
      const p = transformPoint(verts[i], grid, rotation)
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  // 若无有效 bbox，则退回 grid 尺寸
  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0
    maxX = (rotation === 90 || rotation === 270) ? grid.height : grid.width
    maxY = (rotation === 90 || rotation === 270) ? grid.width : grid.height
  }

  // 统一四边留白 + bbox 膨胀，避免顶部/边界被裁剪（stroke/浮点误差/旋转都能兜住）
  const PAD = 26
  const INFLATE = 18
  const boxW = Math.max(1, maxX - minX)
  const boxH = Math.max(1, maxY - minY)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(boxW + (PAD + INFLATE) * 2)
  canvas.height = Math.ceil(boxH + (PAD + INFLATE) * 2)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  // 平移：把 bbox 的左上角对齐到 pad+inflate 区域
  ctx.translate((PAD + INFLATE) - minX, (PAD + INFLATE) - minY)

  // draw triangles (same logic as TriangleCanvas)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.miterLimit = 2
  // 与主画布一致：先 fill；再用黑色细边描边（避免引入额外“同色描边”造成的边界伪影）
  for (const t of triangles) {
    if (!isActiveTriangle(t)) continue
    const verts = (t.drawVertices && t.drawVertices.length >= 3) ? t.drawVertices : t.vertices
    if (!verts || verts.length < 3) continue
    ctx.beginPath()
    const v0 = transformPoint(verts[0], grid, rotation)
    ctx.moveTo(v0.x, v0.y)
    for (let i = 1; i < 3; i++) {
      const vi = transformPoint(verts[i], grid, rotation)
      ctx.lineTo(vi.x, vi.y)
    }
    ctx.closePath()
    ctx.fillStyle = t.color
    ctx.fill()
  }
  // 黑色细边（与主画布一致）
  ctx.lineWidth = 0.5
  ctx.strokeStyle = '#000000'
  for (const t of triangles) {
    if (!isActiveTriangle(t)) continue
    const verts = (t.drawVertices && t.drawVertices.length >= 3) ? t.drawVertices : t.vertices
    if (!verts || verts.length < 3) continue
    ctx.beginPath()
    const v0 = transformPoint(verts[0], grid, rotation)
    ctx.moveTo(v0.x, v0.y)
    for (let i = 1; i < 3; i++) {
      const vi = transformPoint(verts[i], grid, rotation)
      ctx.lineTo(vi.x, vi.y)
    }
    ctx.closePath()
    ctx.stroke()
  }

  // label positions (centroid by region, transformed)
  const labelPos = new Map() // regionId -> {x,y}
  for (const st of stats) {
    if (!st.centroid) continue
    const p = transformPoint(st.centroid, grid, rotation)
    labelPos.set(st.regionId, p)
  }

  // draw labels
  const fontSize = Math.max(10, Math.min(18, Math.round(Math.min(boxW, boxH) / 55)))
  ctx.font = `bold ${fontSize}px system-ui, -apple-system, Segoe UI, Arial`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const st of stats) {
    const p = labelPos.get(st.regionId)
    if (!p) continue
    const label = String(st.regionId + 1)
    const r = Math.max(10, Math.round(fontSize * 0.9))
    ctx.beginPath()
    ctx.fillStyle = 'rgba(0,0,0,0.60)'
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, p.x, p.y)
  }

  ctx.restore()
  return canvas.toDataURL('image/png')
}


