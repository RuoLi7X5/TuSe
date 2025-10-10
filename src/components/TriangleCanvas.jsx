import { forwardRef, useEffect } from 'react'

function transformPoint(pt, grid, rotation){
  if (rotation === 90) {
    // 旋转90°（顺时针），将坐标映射到宽=grid.height，高=grid.width 的画布
    return { x: grid.height - pt.y, y: pt.x }
  }
  return { x: pt.x, y: pt.y }
}

function draw(ctx, grid, triangles, selectedIds, rotation, selectionRect, lassoPath, lassoClosed) {
  if (!ctx) return
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const isSelected = (id)=> Array.isArray(selectedIds) && selectedIds.includes(id)
  // 统一线条端点/拐角样式，避免不同边呈现不一致的粗细或尖角
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.miterLimit = 2

  // 第一轮：仅填充颜色，不描边
  for (const t of triangles) {
    if (t.deleted || t.color === 'transparent') continue
    ctx.beginPath()
    const verts = (t.drawVertices && t.drawVertices.length>=3) ? t.drawVertices : t.vertices
    const v0 = transformPoint(verts[0], grid, rotation)
    ctx.moveTo(v0.x, v0.y)
    for (let i=1;i<verts.length;i++){
      const vi = transformPoint(verts[i], grid, rotation)
      ctx.lineTo(vi.x, vi.y)
    }
    ctx.closePath()
    ctx.fillStyle = t.color
    ctx.fill()
  }

  // 第二轮：非选中三角形基础轮廓（黑色，细线）
  ctx.lineWidth = 1
  ctx.strokeStyle = '#000000'
  for (const t of triangles) {
    if (t.deleted || t.color === 'transparent') continue
    if (isSelected(t.id)) continue
    ctx.beginPath()
    const verts = (t.drawVertices && t.drawVertices.length>=3) ? t.drawVertices : t.vertices
    const v0 = transformPoint(verts[0], grid, rotation)
    ctx.moveTo(v0.x, v0.y)
    for (let i=1;i<verts.length;i++){
      const vi = transformPoint(verts[i], grid, rotation)
      ctx.lineTo(vi.x, vi.y)
    }
    ctx.closePath()
    ctx.stroke()
  }

  // 第三轮：选中三角形高亮轮廓（统一宽度与颜色，置于最上层）
  ctx.lineWidth = 2
  ctx.strokeStyle = '#4f8df7'
  for (const t of triangles) {
    if (t.deleted || t.color === 'transparent') continue
    if (!isSelected(t.id)) continue
    ctx.beginPath()
    const verts = (t.drawVertices && t.drawVertices.length>=3) ? t.drawVertices : t.vertices
    const v0 = transformPoint(verts[0], grid, rotation)
    ctx.moveTo(v0.x, v0.y)
    for (let i=1;i<verts.length;i++){
      const vi = transformPoint(verts[i], grid, rotation)
      ctx.lineTo(vi.x, vi.y)
    }
    ctx.closePath()
    ctx.stroke()
  }

  // 绘制框选矩形覆盖
  if (selectionRect && grid) {
    const { x1, y1, x2, y2 } = selectionRect
    const p1 = transformPoint({ x: x1, y: y1 }, grid, rotation)
    const p2 = transformPoint({ x: x2, y: y2 }, grid, rotation)
    const rx = Math.min(p1.x, p2.x)
    const ry = Math.min(p1.y, p2.y)
    const rw = Math.abs(p2.x - p1.x)
    const rh = Math.abs(p2.y - p1.y)
    ctx.save()
    ctx.strokeStyle = '#4f8df7'
    ctx.lineWidth = 1
    ctx.setLineDash([6, 4])
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(79,141,247,0.12)'
    ctx.fillRect(rx, ry, rw, rh)
    ctx.restore()
  }

  // 绘制自由套索轨迹（白色）
  if (Array.isArray(lassoPath) && lassoPath.length >= 2) {
    ctx.save()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#ffffff'
    const p0 = transformPoint(lassoPath[0], grid, rotation)
    ctx.beginPath()
    ctx.moveTo(p0.x, p0.y)
    for (let i = 1; i < lassoPath.length; i++) {
      const pi = transformPoint(lassoPath[i], grid, rotation)
      ctx.lineTo(pi.x, pi.y)
    }
    if (lassoClosed) ctx.closePath()
    ctx.stroke()
    if (lassoClosed) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.fill()
    }
    // 起点吸附环，辅助闭合提示
    const start = transformPoint(lassoPath[0], grid, rotation)
    ctx.beginPath()
    ctx.arc(start.x, start.y, 8, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }
}

function pointInPolygon(p, verts) {
  // 射线法：统计与水平射线的交点次数（奇数在内，偶数在外）
  let inside = false
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y
    const xj = verts[j].x, yj = verts[j].y
    const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-9) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

export default forwardRef(function TriangleCanvas({ grid, triangles, onClickTriangle, selectedIds, rotation=0, selectionRect, lassoPath, lassoClosed, onDragStart, onDragMove, onDragEnd }, ref) {
  useEffect(() => {
    if (!ref?.current || !grid) return
    const canvas = ref.current
    // 旋转90°时交换画布宽高
    if (rotation === 90) {
      canvas.width = grid.height
      canvas.height = grid.width
    } else {
      canvas.width = grid.width
      canvas.height = grid.height
    }
    const ctx = canvas.getContext('2d')
    draw(ctx, grid, triangles, selectedIds, rotation, selectionRect, lassoPath, lassoClosed)
  }, [grid, triangles, selectedIds, rotation, selectionRect, lassoPath, lassoClosed])

  useEffect(() => {
    if (!ref?.current) return
    const canvas = ref.current
    // 本地拖拽状态与点击抑制标记（闭包变量）
    let wasDragging = false
    let suppressNextClick = false
    const toCanvasXY = (e) => {
      const rect = canvas.getBoundingClientRect()
      const x = (e.clientX - rect.left) * (canvas.width / rect.width)
      const y = (e.clientY - rect.top) * (canvas.height / rect.height)
      return { x, y }
    }
    const inv = (pt)=> {
      if (rotation === 90) {
        return { x: pt.y, y: grid.height - pt.x }
      }
      return pt
    }
    const onClick = (e) => {
      if (suppressNextClick) { suppressNextClick = false; return }
      const { x, y } = toCanvasXY(e)
      // 将点击坐标逆变换回未旋转坐标系
      const p = inv({x,y})
      for (const t of triangles) {
        if (t.deleted || t.color === 'transparent') continue
        const verts = (t.drawVertices && t.drawVertices.length>=3) ? t.drawVertices : t.vertices
        if (pointInPolygon(p, verts)) {
          onClickTriangle?.(t.id, e)
          break
        }
      }
    }
    const onMouseDown = (e) => {
      if (e.button !== 0) return
      // 避免与 Shift/Ctrl 点击选择冲突：按住修饰键时不进入拖拽框选
      if (e.shiftKey || e.ctrlKey) return
      const { x, y } = toCanvasXY(e)
      const p = inv({ x, y })
      onDragStart?.(p, e)
      wasDragging = false
    }
    const onMouseMove = (e) => {
      if (!(e.buttons & 1)) return
      const { x, y } = toCanvasXY(e)
      const p = inv({ x, y })
      onDragMove?.(p, e)
      wasDragging = true
    }
    const onMouseUp = (e) => {
      const { x, y } = toCanvasXY(e)
      const p = inv({ x, y })
      onDragEnd?.(p, e)
      if (wasDragging) suppressNextClick = true
      wasDragging = false
    }
    const onContextMenu = (e) => {
      // 避免右键菜单干扰拖拽结束逻辑
      e.preventDefault()
    }
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [triangles, onClickTriangle, rotation, grid, onDragStart, onDragMove, onDragEnd])

  return <canvas ref={ref} />
})