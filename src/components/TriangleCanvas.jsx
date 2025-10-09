import { forwardRef, useEffect } from 'react'

function transformPoint(pt, grid, rotation){
  if (rotation === 90) {
    // 旋转90°（顺时针），将坐标映射到宽=grid.height，高=grid.width 的画布
    return { x: grid.height - pt.y, y: pt.x }
  }
  return { x: pt.x, y: pt.y }
}

function draw(ctx, grid, triangles, selectedIds, rotation, selectionRect) {
  if (!ctx) return
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  const isSelected = (id)=> Array.isArray(selectedIds) && selectedIds.includes(id)
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
    if (isSelected(t.id)) {
      ctx.lineWidth = 2
      ctx.strokeStyle = '#4f8df7'
    } else {
      ctx.lineWidth = 1
      ctx.strokeStyle = '#000000'
    }
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

export default forwardRef(function TriangleCanvas({ grid, triangles, onClickTriangle, selectedIds, rotation=0, selectionRect, onDragStart, onDragMove, onDragEnd }, ref) {
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
    draw(ctx, grid, triangles, selectedIds, rotation, selectionRect)
  }, [grid, triangles, selectedIds, rotation, selectionRect])

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
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [triangles, onClickTriangle, rotation, grid, onDragStart, onDragMove, onDragEnd])

  return <canvas ref={ref} />
})