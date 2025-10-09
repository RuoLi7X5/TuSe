import { nearestPaletteFromLab, rgb2lab, distLab } from './color-utils'

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

export function buildTriangleGrid(width, height, side) {
  const H = side * Math.sqrt(3) / 2
  // 为了让四边都成为直线，需要让网格在边界外延一圈，再裁剪回矩形
  // 横向步长为 side/2，纵向步长为 H
  const cols = Math.floor((width + side) / (side / 2)) + 2
  const rows = Math.floor((height + H) / H) + 2
  const triangles = []
  let id = 0
  for (let r = -1; r < rows; r++) {
    for (let c = -2; c < cols; c++) {
      const x = c * (side / 2)
      const y = r * H
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
export function buildTriangleGridVertical(width, height, side) {
  const H = side * Math.sqrt(3) / 2
  // 垂直底边模式同样在边界外延一圈再裁剪
  const cols = Math.floor((width + H) / H) + 2
  const rows = Math.floor((height + side / 2) / (side / 2)) + 2
  const triangles = []
  let id = 0
  for (let r = -2; r < rows; r++) {
    for (let c = -1; c < cols; c++) {
      const x = c * H
      const y = r * (side / 2)
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

export async function mapImageToGrid(bitmap, grid, palette) {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width; canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0)
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

  const insidePoint = (p, c, alpha=0.15) => ({ x: p.x*(1-alpha)+c.x*alpha, y: p.y*(1-alpha)+c.y*alpha })
  const midPoint = (a, b) => ({ x: (a.x+b.x)/2, y: (a.y+b.y)/2 })

  return grid.triangles.map(t => {
    const c = t.drawCentroid || t.centroid
    const verts = t.drawVertices || t.vertices
    const v0=verts[0], v1=verts[1], v2=verts[2]
    const pts = [
      c,
      insidePoint(v0, c, 0.20),
      insidePoint(v1, c, 0.20),
      insidePoint(v2, c, 0.20),
      insidePoint(midPoint(v0, v1), c, 0.15),
      insidePoint(midPoint(v1, v2), c, 0.15),
      insidePoint(midPoint(v2, v0), c, 0.15),
    ]
    const labs = pts.map(p=>labAt(p.x, p.y))
    const weights = [2,1,1,1,1.2,1.2,1.2]
    // 初始均值
    const mean1 = weightedMeanLab(labs, weights)
    // 去除离群：与初始均值距离过大者剔除（阈值 25），保留至少 5 个样本
    const ds = labs.map(l=>distLab(l, mean1))
    const order = ds.map((d,i)=>({d,i})).sort((a,b)=>a.d-b.d)
    const keepIdx = order.slice(0, Math.max(5, labs.length-2)).map(o=>o.i)
    const labs2 = keepIdx.map(i=>labs[i])
    const weights2 = keepIdx.map(i=>weights[i])
    const mean2 = weightedMeanLab(labs2, weights2)
    const color = nearestPaletteFromLab(mean2, palette)
    return { ...t, color }
  })
}

export function isUniform(triangles) {
  if (!triangles || triangles.length === 0) return false
  const active = triangles.filter(t => !t.deleted && t.color !== 'transparent')
  if (active.length === 0) return false
  const c = active[0].color
  return active.every(t => t.color === c)
}

// 并查集（Union-Find）用于同色连通分量压缩
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