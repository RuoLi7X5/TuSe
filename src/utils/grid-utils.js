import { nearestPaletteFromLab, rgb2lab, distLab } from './color-utils'

// 并查集（Union-Find）用于同色连通分量压缩
// 放在顶部以防止 ReferenceError (Hoisting Issue)
export class UnionFind {
  constructor(n) {
    this.parent = new Uint32Array(n)
    this.rank = new Uint8Array(n)
    for (let i = 0; i < n; i++) this.parent[i] = i
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  union(a, b) {
    let x = this.find(a), y = this.find(b)
    if (x === y) return false
    if (this.rank[x] < this.rank[y]) { const t = x; x = y; y = t }
    this.parent[y] = x
    if (this.rank[x] === this.rank[y]) this.rank[x]++
    return true
  }
}

// 简单的 hex 转 lab 辅助函数
function hex2lab(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return rgb2lab(r, g, b)
}

// 轴对齐矩形裁剪（Sutherland–Hodgman）：将越界三角形裁剪为画布内的多边形
function clipPolygonToRect(poly, width, height) {
  const clipEdge = (points, edge) => {
    const out = []
    const inside = (p) => {
      switch (edge.type) {
        case 'left': return p.x >= 0
        case 'right': return p.x <= width
        case 'top': return p.y >= 0
        case 'bottom': return p.y <= height
        default: return true
      }
    }
    const intersect = (p1, p2) => {
      if (edge.type === 'left' || edge.type === 'right') {
        const x = edge.type === 'left' ? 0 : width
        const dx = p2.x - p1.x
        if (Math.abs(dx) < 1e-6) return { x, y: p1.y }
        const t = (x - p1.x) / dx
        return { x, y: p1.y + t * (p2.y - p1.y) }
      } else {
        const y = edge.type === 'top' ? 0 : height
        const dy = p2.y - p1.y
        if (Math.abs(dy) < 1e-6) return { x: p1.x, y }
        const t = (y - p1.y) / dy
        return { x: p1.x + t * (p2.x - p1.x), y }
      }
    }
    for (let i = 0; i < points.length; i++) {
      const cur = points[i]
      const prev = points[(i + points.length - 1) % points.length]
      const curIn = inside(cur)
      const prevIn = inside(prev)
      if (prevIn && curIn) {
        out.push(cur)
      } else if (prevIn && !curIn) {
        out.push(intersect(prev, cur))
      } else if (!prevIn && curIn) {
        out.push(intersect(prev, cur))
        out.push(cur)
      }
    }
    return out
  }
  let pts = poly
  for (const edge of [ {type:'left'}, {type:'right'}, {type:'top'}, {type:'bottom'} ]) {
    pts = clipEdge(pts, edge)
    if (!pts || pts.length === 0) return []
  }
  const area = Math.abs(pts.reduce((s,p,i)=>{ const q=pts[(i+1)%pts.length]; return s + (p.x*q.y - q.x*p.y) },0))/2
  if (area < 1e-3 || pts.length < 3) return []
  return pts
}

function triVertices(x, y, side, up) {
  const H = side * Math.sqrt(3) / 2
  if (up) {
    return [
      { x, y: y + H },
      { x: x + side / 2, y },
      { x: x + side, y: y + H },
    ]
  } else {
    return [
      { x, y },
      { x: x + side / 2, y: y + H },
      { x: x + side, y },
    ]
  }
}

export function buildTriangleGrid(width, height, side, offsetX = 0, offsetY = 0) {
  const H = side * Math.sqrt(3) / 2
  // 为了让四边都成为直线，需要让网格在边界外延一圈，再裁剪回矩形
  // 横向步长为 side/2，纵向步长为 H
  // 扩大覆盖范围以适应较大的 offset (pMod 后 offset 可能接近 2H 或 S)
  const cols = Math.floor((width + side) / (side / 2)) + 4
  const rows = Math.floor((height + H) / H) + 4
  const triangles = []
  let id = 0
  // 起始索引向前扩展，确保 offset 较大时也能覆盖 0 坐标附近的区域
  for (let r = -3; r < rows; r++) {
    for (let c = -4; c < cols; c++) {
      const x = c * (side / 2) + offsetX
      const y = r * H + offsetY
      const up = ((r + c) % 2 === 0)
      const v = triVertices(x, y, side, up)
      // 对越界三角形进行裁剪，生成用于绘制/采样的多边形
      const clipped = clipPolygonToRect(v, width, height)
      if (clipped.length >= 3) {
        const cx = (v[0].x + v[1].x + v[2].x) / 3
        const cy = (v[0].y + v[1].y + v[2].y) / 3
        const dcx = clipped.reduce((s,p)=>s+p.x,0)/clipped.length
        const dcy = clipped.reduce((s,p)=>s+p.y,0)/clipped.length
        triangles.push({ id: id++, r, c, up, vertices: v, centroid: { x: cx, y: cy }, drawVertices: clipped, drawCentroid: { x: dcx, y: dcy } })
      }
    }
  }
  // 构建邻接（共享边）
  const edgeKey = (a, b) => {
    const k1 = `${a.x.toFixed(2)},${a.y.toFixed(2)}`
    const k2 = `${b.x.toFixed(2)},${b.y.toFixed(2)}`
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
  }
  const edgeMap = new Map()
  for (const t of triangles) {
    for (let i = 0; i < 3; i++) {
      const a = t.vertices[i]
      const b = t.vertices[(i + 1) % 3]
      const ek = edgeKey(a, b)
      if (!edgeMap.has(ek)) edgeMap.set(ek, [])
      edgeMap.get(ek).push(t.id)
    }
  }
  const neighbors = new Map()
  for (const t of triangles) neighbors.set(t.id, new Set())
  for (const [, ids] of edgeMap.entries()) {
    if (ids.length === 2) {
      neighbors.get(ids[0]).add(ids[1])
      neighbors.get(ids[1]).add(ids[0])
    }
  }
  for (const t of triangles) t.neighbors = Array.from(neighbors.get(t.id))
  return { width, height, side, H, triangles }
}

// 竖直底边（左右朝向）的等边三角形顶点
function triVerticesVertical(x, y, side, left) {
  const H = side * Math.sqrt(3) / 2
  if (left) {
    // 朝左：顶点在左侧，底边为 x+H 的竖线段
    return [
      { x: x, y: y + side / 2 },
      { x: x + H, y: y },
      { x: x + H, y: y + side },
    ]
  } else {
    // 朝右：顶点在右侧，底边为 x 的竖线段
    return [
      { x: x + H, y: y + side / 2 },
      { x: x, y: y },
      { x: x, y: y + side },
    ]
  }
}

// 构建“底边竖直”的网格（等价于原网格分布旋转90°）
export function buildTriangleGridVertical(width, height, side, offsetX = 0, offsetY = 0) {
  const H = side * Math.sqrt(3) / 2
  // 垂直底边模式同样在边界外延一圈再裁剪
  // 扩大覆盖范围
  const cols = Math.floor((width + H) / H) + 4
  const rows = Math.floor((height + side / 2) / (side / 2)) + 4
  const triangles = []
  let id = 0
  // 起始索引向前扩展
  for (let r = -4; r < rows; r++) {
    for (let c = -3; c < cols; c++) {
      const x = c * H + offsetX
      const y = r * (side / 2) + offsetY
      const left = ((r + c) % 2 === 0)
      const v = triVerticesVertical(x, y, side, left)
      const clipped = clipPolygonToRect(v, width, height)
      if (clipped.length >= 3) {
        const cx = (v[0].x + v[1].x + v[2].x) / 3
        const cy = (v[0].y + v[1].y + v[2].y) / 3
        const dcx = clipped.reduce((s,p)=>s+p.x,0)/clipped.length
        const dcy = clipped.reduce((s,p)=>s+p.y,0)/clipped.length
        triangles.push({ id: id++, r, c, left, vertices: v, centroid: { x: cx, y: cy }, drawVertices: clipped, drawCentroid: { x: dcx, y: dcy } })
      }
    }
  }
  // 邻接构建（共享边）
  const edgeKey = (a, b) => {
    const k1 = `${a.x.toFixed(2)},${a.y.toFixed(2)}`
    const k2 = `${b.x.toFixed(2)},${b.y.toFixed(2)}`
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
  }
  const edgeMap = new Map()
  for (const t of triangles) {
    for (let i = 0; i < 3; i++) {
      const a = t.vertices[i]
      const b = t.vertices[(i + 1) % 3]
      const ek = edgeKey(a, b)
      if (!edgeMap.has(ek)) edgeMap.set(ek, [])
      edgeMap.get(ek).push(t.id)
    }
  }
  const neighbors = new Map()
  for (const t of triangles) neighbors.set(t.id, new Set())
  for (const [, ids] of edgeMap.entries()) {
    if (ids.length === 2) {
      neighbors.get(ids[0]).add(ids[1])
      neighbors.get(ids[1]).add(ids[0])
    }
  }
  for (const t of triangles) t.neighbors = Array.from(neighbors.get(t.id))
  return { width, height, side, H, triangles }
}

export function rectifyColorsByGrid(triangles, gridSpec) {
  if (!gridSpec || !gridSpec.success) return false;

  const { spacing, anchors, angles } = gridSpec;
  const degToRad = Math.PI / 180;
  const cs = angles.map(deg => ({ c: Math.cos(deg * degToRad), s: Math.sin(deg * degToRad) }));

  // Map to store groups: "k1,k2,k3" -> [triangleIndices]
  const groups = new Map();
  const idToIndex = new Map(triangles.map((t, i) => [t.id, i]));

  triangles.forEach((t, idx) => {
    if (t.deleted || t.color === 'transparent') return;
    const { x, y } = t.centroid;
    
    // Calculate 3 indices
    // k = floor((rho - anchor) / spacing)
    const keys = [];
    for (let i = 0; i < 3; i++) {
      const rho = x * cs[i].c + y * cs[i].s;
      keys.push(Math.floor((rho - anchors[i]) / spacing));
    }
    
    const key = keys.join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx);
  });

  let hasChange = false;
  const updates = [];
  
  // Vote and assimilate
  for (const [key, indices] of groups) {
    if (indices.length === 0) continue;
    
    // Count colors
    const counts = {};
    let maxCount = 0;
    let maxColor = null;
    
    for (const idx of indices) {
      const c = triangles[idx].color;
      counts[c] = (counts[c] || 0) + 1;
      if (counts[c] > maxCount) {
        maxCount = counts[c];
        maxColor = c;
      }
    }
    
    // Assimilate all to maxColor
    for (const idx of indices) {
      if (triangles[idx].color !== maxColor) {
        updates.push({ index: idx, color: maxColor });
        hasChange = true;
      }
    }
  }
  
  // Apply updates
  for (const u of updates) {
    triangles[u.index].color = u.color;
  }
  
  return hasChange;
}

export function denoiseGrid(triangles) {
  const idToIndex = new Map(triangles.map((t, i) => [t.id, i]))

  // 阶段一：局部去噪（基于邻居颜色投票）
  // 规则更新：
  // 1. 内部三角形 (3邻居): 
  //    - 必须没有同色邻居 (User: "只有两个是B色，一个是A色...不能被同化")
  //    - 允许 2B+1C 的情况同化为 B (User: "两个B，一个C时也同化为B")
  //    - 当然也包含 3B 的情况
  // 2. 边界三角形 (2邻居):
  //    - 只要没有同色邻居，就同化 (User: "边界上...周围不存在与自身颜色相同的...就被同化")
  
  const MAX_ITER = 50
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const updates = []
    let hasChange = false

    for (const t of triangles) {
      if (t.deleted || t.color === 'transparent') continue
      
      const neighbors = t.neighbors.map(nid => triangles[idToIndex.get(nid)])
        .filter(n => n && !n.deleted && n.color !== 'transparent')
      
      if (neighbors.length === 0) continue

      const selfColor = t.color
      const counts = {}
      let maxCount = 0
      let maxColor = null
      let hasSelf = false

      for (const n of neighbors) {
        const c = n.color
        if (c === selfColor) hasSelf = true
        counts[c] = (counts[c] || 0) + 1
        if (counts[c] > maxCount) {
          maxCount = counts[c]
          maxColor = c
        }
      }

      // 核心原则：只要邻居里有“自己人”，就绝不同化，保留细节
      if (hasSelf) continue

      // 此时 t 已经被异色完全包围 (neighbors 都不等于 selfColor)
      
      if (neighbors.length === 3) {
        // 内部三角形
        // 规则：2B+1C -> B; 3B -> B
        // 即：优势颜色的数量 >= 2
        if (maxCount >= 2) {
          updates.push({ index: idToIndex.get(t.id), color: maxColor })
          hasChange = true
        }
      } else if (neighbors.length <= 2) {
        // 边界三角形 (2个或1个邻居)
        // 规则：只要被异色包围（hasSelf=false），就同化
        if (maxColor) {
          updates.push({ index: idToIndex.get(t.id), color: maxColor })
          hasChange = true
        }
      }
    }

    if (!hasChange) break
    
    // 应用更新
    for (const u of updates) {
      triangles[u.index].color = u.color
    }
  }

  return triangles
}

// 移除小连通区域（岛屿去除）
// 针对用户需求：把被异色包围的区域同化。
// 用户强调：必须是严格包围。即外部所有邻居必须是同一种颜色。
export function removeSmallComponents(triangles, minSize = 4) {
  const n = triangles.length
  const idToIndex = new Map(triangles.map((t, i) => [t.id, i]))
  let hasChange = false

  // 反复迭代直到稳定，防止一次合并产生新的小岛屿
  for (let iter = 0; iter < 10; iter++) {
    let iterChange = false
    
    // 1. 构建连通分量
    const uf = new UnionFind(n)
    for (let i = 0; i < n; i++) {
      const t = triangles[i]
      if (t.deleted || t.color === 'transparent') continue
      for (const nid of t.neighbors) {
        const j = idToIndex.get(nid)
        if (j !== undefined) {
          const nt = triangles[j]
          if (!nt.deleted && nt.color !== 'transparent' && nt.color === t.color) {
            uf.union(i, j)
          }
        }
      }
    }

    // 2. 统计每个分量的大小和成员
    const compMembers = new Map() // root -> [indices]
    for (let i = 0; i < n; i++) {
      const t = triangles[i]
      if (t.deleted || t.color === 'transparent') continue
      const root = uf.find(i)
      if (!compMembers.has(root)) compMembers.set(root, [])
      compMembers.get(root).push(i)
    }

    // 3. 处理小分量
    const updates = []
    for (const [root, members] of compMembers) {
      if (members.length < minSize) {
        // 这是一个小岛屿，需要同化
        // 收集所有成员的外部邻居颜色
        const neighborColors = new Set()
        for (const idx of members) {
          const t = triangles[idx]
          for (const nid of t.neighbors) {
            const j = idToIndex.get(nid)
            if (j !== undefined) {
              const nt = triangles[j]
              // 邻居必须不在当前分量内
              if (uf.find(j) !== root && !nt.deleted && nt.color !== 'transparent') {
                neighborColors.add(nt.color)
              }
            }
          }
        }

        // 严格规则：只有当外部邻居仅有 1 种颜色时才同化
        // 如果外部有两种或以上颜色（例如夹在色块A和B之间），则不动，避免错误同化
        if (neighborColors.size === 1) {
          const bestColor = neighborColors.values().next().value
          for (const idx of members) {
            updates.push({ index: idx, color: bestColor })
          }
          iterChange = true
        }
      }
    }

    // 应用更新
    for (const u of updates) {
      triangles[u.index].color = u.color
    }

    if (iterChange) hasChange = true
    else break // 稳定了
  }

  return hasChange
}

// 拓扑修复：强制执行“顶点最多3色交汇”的约束
// 因为三角形网格中，任意内部顶点有6个三角形交汇。如果交汇的颜色超过3种，说明拓扑过于破碎，不符合物理/游戏规则。
function rectifyGridTopology(triangles) {
  const idToIndex = new Map(triangles.map((t, i) => [t.id, i]))
  
  // 1. 构建 顶点 -> 三角形列表 的映射
  // 坐标取整以避免浮点误差
  const vKey = (v) => `${Math.round(v.x)},${Math.round(v.y)}`
  const vertMap = new Map() // key -> [triId, triId, ...]
  
  for (const t of triangles) {
    if (t.deleted || t.color === 'transparent') continue
    for (const v of t.vertices) {
      const k = vKey(v)
      if (!vertMap.has(k)) vertMap.set(k, [])
      vertMap.get(k).push(t.id)
    }
  }

  const updates = new Map() // index -> newColor

  // 2. 遍历所有顶点，检查颜色数量
  for (const [key, triIds] of vertMap) {
    if (triIds.length < 4) continue // 边界顶点或少于4个邻居的不用管

    const colors = new Map() // color -> count
    for (const tid of triIds) {
      const idx = idToIndex.get(tid)
      const t = triangles[idx]
      const c = t.color
      colors.set(c, (colors.get(c) || 0) + 1)
    }

    // 用户需求变更：顶点处最多允许6种颜色交汇
    // 在三角网格中，内部顶点最多有6个邻居，因此 > 6 实际上永远不会触发（除非有重叠等异常）
    // 这实际上取消了对顶点颜色数量的强制简化约束，允许更丰富的细节。
    if (colors.size > 6) {
      // 违反约束：超过6种颜色
      const sortedColors = [...colors.entries()].sort((a, b) => b[1] - a[1]) // count desc
      const keepColors = new Set(sortedColors.slice(0, 6).map(x => x[0]))
      const targetColor = sortedColors[0][0] // 默认同化为最优势颜色

      for (const tid of triIds) {
        const idx = idToIndex.get(tid)
        const t = triangles[idx]
        if (!keepColors.has(t.color)) {
          updates.set(idx, targetColor)
        }
      }
    }
  }

  // 应用修改
  if (updates.size > 0) {
    for (const [idx, color] of updates) {
      triangles[idx].color = color
    }
    return true // 发生了变化
  }
  return false
}

// 边界平滑：消除锯齿（Straighten Edges）
// 针对“锯齿”现象（例如 1-pixel 宽度的突出），进行平滑
function smoothBoundaries(triangles) {
  // 用户反馈：只有当三角形被 3 个同色邻居完全包围时才同化
  // smoothBoundaries 原有的 "2个邻居同色就同化" 规则过于激进，导致错误同化
  // 因此这里直接返回 false，不做任何操作。
  // 严格的去噪逻辑已完全由 denoiseGrid 和 removeSmallComponents 接管。
  return false
}

export async function mapImageToGrid(bitmap, grid, palette, options = {}) {
  const { aiSegmentation, aiScale, rectifyMode, applyDenoise = true } = options
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width; canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  // 1. 预处理：轻微模糊以平滑噪点和压缩伪影
  ctx.filter = 'blur(1px)'
  ctx.drawImage(bitmap, 0, 0)
  ctx.filter = 'none' // 恢复
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = img.data
  const labAt = (x, y) => {
    const ix = Math.max(0, Math.min(img.width - 1, Math.round(x)))
    const iy = Math.max(0, Math.min(img.height - 1, Math.round(y)))
    const i = (iy * img.width + ix) * 4
    const r = data[i], g = data[i + 1], b = data[i + 2]
    return rgb2lab(r, g, b)
  }

  const weightedMeanLab = (labs, weights) => {
    let L=0, a=0, b=0, wsum=0
    for(let i=0;i<labs.length;i++){
      const w=weights[i]||1; wsum+=w
      L+=labs[i][0]*w; a+=labs[i][1]*w; b+=labs[i][2]*w
    }
    return [L/wsum, a/wsum, b/wsum]
  }

  // 辅助：获取 AI 掩码颜色
  // 如果提供了 aiSegmentation，则尝试查询某个点所在的分割区域的平均色
  // 目前我们只从原图采样，但利用 mask 聚合
  // 由于 mask 结构复杂，这里简化逻辑：
  // 我们直接让每个三角形去“投票”它覆盖的 mask 区域
  // 如果一个三角形主要落在 Mask A，则它应该使用 Mask A 的代表色
  
  // 预处理 AI Mask (SAM Raw Output)
  // aiSegmentation 结构: { type: 'sam_raw', results: [ { point, maskRaw, scores }, ... ], maskSize: 256, originalSize }
  let maskColors = new Map() // maskIndex (in results array) -> averageLab
  let samResults = null
  let maskW = 256, maskH = 256 // SAM default output size
  let origW = bitmap.width, origH = bitmap.height
  
  if (aiSegmentation && aiSegmentation.type === 'sam_raw' && aiSegmentation.results) {
    try {
      samResults = aiSegmentation.results
      maskW = aiSegmentation.maskSize || 256
      maskH = aiSegmentation.maskSize || 256
      origW = aiSegmentation.originalSize?.width || bitmap.width
      origH = aiSegmentation.originalSize?.height || bitmap.height
      
      // 为每个 Mask 计算其代表颜色（通过采样原图）
      // 由于 SAM Mask 是 256x256 的 logits，我们需要先解码
      // 为了性能，我们不在这里做昂贵的全图解码
      // 而是：只对每个 Mask 的正样本区域进行稀疏采样
      
      samResults.forEach((res, idx) => {
        // res.point 是 prompt 点，包含 color (Hex)
        // 我们直接信任这个 prompt 点的颜色作为该 mask 的代表色
        // 因为这些点是基于当前网格的最大连通区域计算出来的，颜色是可靠的
        if (res.point && res.point.color) {
          maskColors.set(idx, hex2lab(res.point.color))
        }
      })
      
    } catch (e) {
      console.warn('AI mask processing failed:', e)
      samResults = null
    }
  }

  const insidePoint = (p, c, alpha=0.15) => ({ x: p.x*(1-alpha)+c.x*alpha, y: p.y*(1-alpha)+c.y*alpha })
  const midPoint = (a, b) => ({ x: (a.x+b.x)/2, y: (a.y+b.y)/2 })

  const mappedTriangles = grid.triangles.map(t => {
    const c = t.drawCentroid || t.centroid
    const verts = t.drawVertices || t.vertices
    const v0=verts[0], v1=verts[1], v2=verts[2]
    
    // AI 路径：SAM (如果处于校准模式或已就绪)
    if (samResults && maskColors.size > 0) {
      // 采样三角形中心点
      // 坐标映射：Tri (orig size) -> Mask (256x256)
      // 注意：App.jsx 传入的 aiScale 已经作用于 prompts，但这里我们需要将三角形坐标映射到 mask 空间
      // SAM 的 mask 是相对于原图（输入给 SAM 的图）的。
      // App.jsx 中：offCanvas 尺寸为 w, h (缩放后的)。aiSegmentation.originalSize 记录的是这个尺寸。
      // 而 grid 是基于原图 bitmap 的。
      // 所以我们需要两步缩放： Grid -> OffCanvas (aiScale) -> Mask (256x256)
      
      const scaleX = maskW / origW
      const scaleY = maskH / origH
      
      // 采样点：中心点 + 3个顶点 + 中点 (增强采样密度，避免小三角形漏网)
      const pts = [
          c, v0, v1, v2,
          midPoint(v0, v1), midPoint(v1, v2), midPoint(v2, v0)
      ]
      
      // 投票：看哪个 Mask 在这些点上的 logit 值最大
      // 注意：SAM 返回的是 logits，> 0 表示前景
      let bestMaskIdx = -1
      let maxVote = -Infinity
      let totalHit = 0
      
      // 遍历所有 masks (通常只有 4-10 个颜色种类)
      for (let i = 0; i < samResults.length; i++) {
        const maskObj = samResults[i].maskRaw
        const maskData = maskObj?.data 
        if (!maskData) continue
        
        // 使用每个 Mask 自己的尺寸
        const mW = maskObj.width || maskW
        const mH = maskObj.height || maskH
        
        // 重新计算缩放比例：Grid -> OffCanvas (aiScale) -> Mask (mW, mH)
        const sX = mW / origW
        const sY = mH / origH

        let score = 0
        let hit = 0
        for (const p of pts) {
          // 坐标变换
          const mx = Math.floor(p.x * aiScale * sX)
          const my = Math.floor(p.y * aiScale * sY)
          
          if (mx >= 0 && mx < mW && my >= 0 && my < mH) {
            const val = maskData[my * mW + mx]
            if (val > 0) {
              score += val // 累加 logit/binary 作为置信度
              hit++
            }
          }
        }
        
        // 记录最佳匹配
        if (hit > 0 && score > maxVote) {
          maxVote = score
          bestMaskIdx = i
          totalHit = hit
        }
      }
      
      // 决策：
      // 如果处于 rectifyMode (强力纠正)，只要有命中就采纳
      // 否则，需要较高的置信度（例如至少一半的采样点命中）
      const threshold = rectifyMode ? 1 : Math.ceil(pts.length * 0.4)
      
      // 核心修正：当 AI 识别出有效 Mask 时，强制信任 AI 的边界。
      // 即便只有部分点命中（例如边界上的三角形），只要命中了高置信度的 Mask，就应该被吸附过去。
      // 这能解决“应该紧贴边界却被错误联通”的问题。
      if (bestMaskIdx !== -1 && totalHit >= threshold && maskColors.has(bestMaskIdx)) {
        // 如果是 rectifyMode，我们额外检查：
        // 如果当前三角形位于两个 Mask 的交界处（即存在竞争），我们应该选择得分更高的那个。
        // 上面的逻辑已经选择了 maxVote，但为了防止“粘连”，我们需要确保这个 vote 足够显著。
        
        // 针对用户反馈的“错误联通”问题：
        // 往往是因为某些边缘像素被错误归类到了相邻的大色块。
        // 这里我们引入一个“排他性”检查：如果一个三角形同时命中了多个 Mask，
        // 我们只在它们分数差异明显时才切换，否则保持原样或更谨慎处理？
        // 不，AI 的 Mask 应该是权威的。如果 AI 说它是红色，它就该是红色。
        // 问题可能出在 Mask 本身的精度（缩放损失）或者采样点不足。
        
        return { ...t, meanLab: maskColors.get(bestMaskIdx) }
      }
    }

    // 传统路径：采样点分布 + 投票策略 (Majority Vote)
    // 之前使用加权平均 Lab (weightedMeanLab)，但这会导致边界处的颜色混合（如红+白=粉），
    // 如果粉色不在调色板中，最近邻可能映射错误（如映射回红色而不是白色）。
    // 现在改为：对每个采样点分别寻找最近邻颜色，然后进行投票。
    const pts = [
      c,
      insidePoint(v0, c, 0.20),
      insidePoint(v1, c, 0.20),
      insidePoint(v2, c, 0.20),
      insidePoint(midPoint(v0, v1), c, 0.15),
      insidePoint(midPoint(v1, v2), c, 0.15),
      insidePoint(midPoint(v2, v0), c, 0.15),
      // 增加中心区域权重
      insidePoint(c, v0, 0.05),
      insidePoint(c, v1, 0.05),
      insidePoint(c, v2, 0.05)
    ]
    
    const votes = new Map() // hex -> weight
    for (const p of pts) {
      const lab = labAt(p.x, p.y)
      // 为每个点单独找最近邻调色板颜色
      const hex = nearestPaletteFromLab(lab, palette)
      // 中心点权重略高
      const weight = (p === c) ? 2 : 1
      votes.set(hex, (votes.get(hex) || 0) + weight)
    }
    
    // 找出票数最高的颜色
    let bestHex = null
    let maxVote = -1
    for (const [hex, count] of votes.entries()) {
      if (count > maxVote) {
        maxVote = count
        bestHex = hex
      }
    }
    
    return { ...t, color: bestHex, meanLab: hex2lab(bestHex) }
  })
  
  // 第二阶段：统一映射到当前调色板 (此时 t.color 已经是调色板颜色，只需透传)
  const finalTriangles = mappedTriangles.map(t => {
    // 如果上一步某种原因没拿到 color，这里兜底
    if (!t.color) {
        const color = nearestPaletteFromLab(t.meanLab, palette)
        return { ...t, color }
    }
    return t
  })
  
  // 3. 后处理：去噪（孤立点消除）
  // 如果使用了 AI 校准，则跳过传统去噪（applyDenoise=false），因为 AI 已经保证了语义一致性，且避免“同化”逻辑破坏 AI 的涂色
  if (applyDenoise) {
    denoiseGrid(finalTriangles)
    
    // 新增：强力去除小岛屿（Assimilation）
    // 按照用户要求：把被异色包围的单独三角形（或极小区域）同化
    // 阈值设为 4，意味着大小为 1, 2, 3 的孤立区域都会被同化
    removeSmallComponents(finalTriangles, 4)
  }

  // 4. 新增：拓扑修复与边界平滑（针对 AI 校准后的进一步几何优化）
  // 反复迭代直到稳定，优先平滑，再修复拓扑
  for(let i=0; i<10; i++) {
     let changed = false
     // 修复拓扑（顶点最多6色，防止极端破碎）
     if (rectifyGridTopology(finalTriangles)) changed = true
     
     // 仅在允许去噪（非 AI 强力校准）模式下执行同化逻辑
     if (applyDenoise) {
       // 再次去除可能产生的小岛屿（坚持严格的同化规则）
       if (removeSmallComponents(finalTriangles, 3)) changed = true
       // 局部去噪（坚持严格的 3B->B, 2B+1C->B 规则）
       if (denoiseGrid(finalTriangles)) changed = true
     }
     
     if (!changed) break
  }

  return finalTriangles
}

function lab2rgb(L, a, b) {
  // 简化的 lab2rgb 实现，用于内部转换
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200
  x = 0.95047 * (x * x * x > 0.008856 ? x * x * x : (x - 16 / 116) / 7.787)
  y = 1.00000 * (y * y * y > 0.008856 ? y * y * y : (y - 16 / 116) / 7.787)
  z = 1.08883 * (z * z * z > 0.008856 ? z * z * z : (z - 16 / 116) / 7.787)
  let r = x * 3.2406 + y * -1.5372 + z * -0.4986
  let g = x * -0.9689 + y * 1.8758 + z * 0.0415
  let b_val = x * 0.0557 + y * -0.2040 + z * 1.0570
  r = Math.round(Math.max(0, Math.min(255, (r > 0.0031308 ? (1.055 * Math.pow(r, 1 / 2.4) - 0.055) : 12.92 * r) * 255)))
  g = Math.round(Math.max(0, Math.min(255, (g > 0.0031308 ? (1.055 * Math.pow(g, 1 / 2.4) - 0.055) : 12.92 * g) * 255)))
  b_val = Math.round(Math.max(0, Math.min(255, (b_val > 0.0031308 ? (1.055 * Math.pow(b_val, 1 / 2.4) - 0.055) : 12.92 * b_val) * 255)))
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b_val.toString(16).padStart(2,'0')}`
}

export function isUniform(triangles) {
  if (!triangles || triangles.length === 0) return false
  const active = triangles.filter(t => !t.deleted && t.color !== 'transparent')
  if (active.length === 0) return false
  const c = active[0].color
  return active.every(t => t.color === c)
}

// 根据当前三角形颜色，将同色连通分量压缩为组件，并构建组件邻接关系（RAG）
export function buildRAG(triangles) {
  const n = triangles.length
  const idToIndex = new Map(triangles.map((t, i) => [t.id, i]))
  const uf = new UnionFind(n)
  // 合并同色且共享边的三角形
  for (let i = 0; i < n; i++) {
    const ti = triangles[i]
    if (ti.deleted || ti.color === 'transparent') continue
    for (const nb of ti.neighbors) {
      const j = idToIndex.get(nb)
      if (j == null) continue
      const tj = triangles[j]
      if (tj.deleted || tj.color === 'transparent') continue
      if (tj.color === ti.color) uf.union(i, j)
    }
  }
  // 映射 root -> componentId
  const rootToComp = new Map()
  let compCount = 0
  const triToComp = new Array(n)
  for (let i = 0; i < n; i++) {
    const r = uf.find(i)
    if (!rootToComp.has(r)) rootToComp.set(r, compCount++)
    triToComp[i] = rootToComp.get(r)
  }
  // 组件信息与邻接
  const components = Array.from({ length: compCount }, () => ({ color: null, members: [] }))
  const compAdjSets = Array.from({ length: compCount }, () => new Set())
  for (let i = 0; i < n; i++) {
    const cId = triToComp[i]
    const t = triangles[i]
    if (!components[cId].color) components[cId].color = t.color
    components[cId].members.push(t.id)
    for (const nb of t.neighbors) {
      const j = idToIndex.get(nb)
      if (j == null) continue
      const cj = triToComp[j]
      if (cj !== cId) {
        compAdjSets[cId].add(cj)
        compAdjSets[cj].add(cId)
      }
    }
  }
  const compAdj = compAdjSets.map(s => Array.from(s))
  // 边界度量：每个组件与其它组件的“跨边界邻接”数量
  const boundaryDegree = new Uint32Array(compCount)
  for (let i = 0; i < n; i++) {
    const ci = triToComp[i]
    const ti = triangles[i]
    for (const nb of ti.neighbors) {
      const j = idToIndex.get(nb)
      if (j == null) continue
      const cj = triToComp[j]
      if (cj !== ci) boundaryDegree[ci]++
    }
  }
  return { components, compAdj, triToComp, boundaryDegree }
}

// 统计调色板各色在当前网格的出现次数（过滤 deleted/transparent）
export function colorFrequency(triangles) {
  const freq = new Map()
  for (const t of triangles) {
    if (t.deleted || t.color === 'transparent') continue
    freq.set(t.color, (freq.get(t.color) || 0) + 1)
  }
  return freq
}

// 生成 AI 调试图像（可视化 Masks 和 Prompts）
export async function generateAiDebugImage(bitmap, aiSegmentation) {
  if (!aiSegmentation || !aiSegmentation.results) return null

  const w = bitmap.width
  const h = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  // 1. 背景处理：保持透明
  // 用户要求：不需要纯黑背景，也不需要原图，只保留 AI 识别的色块拼凑
  ctx.clearRect(0, 0, w, h)
  
  // 2. 绘制 Masks
  
  if (aiSegmentation.results.length === 0) {
    ctx.fillStyle = 'red'
    ctx.font = '24px sans-serif'
    ctx.fillText('NO AI RESULTS', 20, 50)
    
    // 尝试绘制错误信息
    if (aiSegmentation.errors && aiSegmentation.errors.length > 0) {
        ctx.fillStyle = 'orange'
        ctx.font = '14px monospace'
        let y = 80
        aiSegmentation.errors.slice(0, 10).forEach(err => {
            const msg = `${err.color}: ${err.error}`
            ctx.fillText(msg.substring(0, 60), 20, y)
            y += 20
        })
    }
    
    return canvas.toDataURL('image/png')
  }

  aiSegmentation.results.forEach((res, idx) => {
    if (!res.maskRaw || !res.maskRaw.data) return

    // 使用每个 Mask 自己的尺寸
    const mW = res.maskRaw.width
    const mH = res.maskRaw.height
    
    // 离屏 Canvas 用于处理当前 Mask
    const maskCanvas = document.createElement('canvas')
    maskCanvas.width = mW
    maskCanvas.height = mH
    const mCtx = maskCanvas.getContext('2d')
    const mImgData = mCtx.createImageData(mW, mH)

    // 使用 Prompt 的颜色（用户调色板颜色）
    // 如果没有颜色，回退到红色
    const hex = res.point?.color || '#ff0000'
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)

    const data = res.maskRaw.data // Float32Array or Uint8Array
    const pixels = mImgData.data

    // 填充 Mask 像素
    for (let i = 0; i < mW * mH; i++) {
      const val = data[i]
      const isForeground = (val > 0) 
      
      const pIdx = i * 4
      if (isForeground) {
        pixels[pIdx] = r
        pixels[pIdx + 1] = g
        pixels[pIdx + 2] = b
        pixels[pIdx + 3] = 255 // 完全不透明，展示“色块化”效果
      } else {
        pixels[pIdx + 3] = 0 
      }
    }

    mCtx.putImageData(mImgData, 0, 0)
    
    // 绘制放大后的 Mask 到主画布
    // 这一步将产生“色块拼图”效果，即用户想要的“标准模板”
    ctx.imageSmoothingEnabled = false 
    ctx.drawImage(maskCanvas, 0, 0, w, h)
  })

  // 3. 绘制 Prompt Points
  const scale = w / (aiSegmentation.originalSize?.width || w) // aiScale 已经用于 prompts 吗？
  // 注意：aiSegmentation.results 中的 point 是原始 prompt 点
  // 在 App.jsx 中生成 prompt 时，坐标是基于缩放后的 offCanvas (aiScale)
  // aiSegmentationMap 中保存了 aiScale。
  // 如果 bitmap 是原图，我们需要把 prompt 坐标 / aiScale 还原回原图坐标
  
  const aiScale = aiSegmentation.aiScale || 1
  
  aiSegmentation.results.forEach((res, idx) => {
    if (!res.point) return
    const p = res.point
    
    // 还原坐标
    const cx = p.x / aiScale
    const cy = p.y / aiScale
    
    // 绘制点
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fillStyle = 'white'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = 'black'
    ctx.stroke()
    
    // 绘制索引/颜色标记
    ctx.fillStyle = 'white'
    ctx.font = '12px sans-serif'
    ctx.fillText(`#${idx}`, cx + 8, cy)
  })

  return canvas.toDataURL('image/png')
}
