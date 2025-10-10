import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

import UploadPanel from './components/UploadPanel'
import TriangleCanvas from './components/TriangleCanvas'
import Controls from './components/Controls'
import StepsPanel from './components/StepsPanel'
import HelpPage from './components/HelpPage'

import { quantizeImage, setColorTuning } from './utils/color-utils'
import { buildTriangleGrid, buildTriangleGridVertical, mapImageToGrid, isUniform, colorFrequency } from './utils/grid-utils'
import { floodFillRegion, attachSolverToWindow, captureCanvasPNG } from './utils/solver'

// 设置默认的求解器开关与权重，并合并本地持久化配置（localStorage）
if (typeof window !== 'undefined') {
  let persisted = null
  try { persisted = JSON.parse(localStorage.getItem('solverFlags') || 'null') } catch {}
  // 默认初始配置：与性能调节窗口一致，开箱即用
  window.SOLVER_FLAGS = {
    // 基本搜索策略
    enableLB: true,
    enableLookahead: true,
    enableLookaheadDepth2: false,
    enableIncremental: true,
    enableBeam: false,
    beamWidth: 32,
    enableBestFirst: true,
    enableBridgeFirst: true,
    enableZeroExpandFilter: true,
    useDFSFirst: false,
    returnFirstFeasible: false,
    logPerf: true,
    // 进度与时间预算
    workerTimeBudgetMs: 300000,
    preprocessTimeBudgetMs: 20000,
    progressComponentsIntervalMs: 0,
    progressDFSIntervalMs: 100,
    // 权重参数
    adjAfterWeight: 0.6,
    bridgeWeight: 1,
    gateWeight: 0.4,
    richnessWeight: 0.5,
    boundaryWeight: 0.8,
    regionClassWeights: { boundary: 0.8, bridge: 1, richness: 0.6 },
    dimensionWeights: { expand: 1, connect: 0.8, barrier: 0.7 },
    bifrontWeight: 2,
    // 稀有颜色与扩张过滤
    rareFreqRatio: 0.03,
    rareFreqAbs: 3,
    rareAllowBridgeMin: 2,
    rareAllowGateMin: 1,
    minDeltaRatio: 0.02,
    lbImproveMin: 1,
    // 路径优化
    optimizeWindowSize: 5,
    optimizeEnableWindow: true,
    optimizeEnableRemoval: true,
    optimizeSwapPasses: 1,
    // 合并已有与持久化设置，持久化优先生效
    ...(window.SOLVER_FLAGS || {}),
    ...(persisted || {}),
  }
}
attachSolverToWindow()

function App() {
  // 简易哈希路由：用于“说明”子页
  const [route, setRoute] = useState(() => (typeof window!=='undefined' ? window.location.hash : ''))
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [imgBitmap, setImgBitmap] = useState(null)
  const [palette, setPalette] = useState([])
  const [grid, setGrid] = useState(null)
  const [triangles, setTriangles] = useState([])
  const [selectedColor, setSelectedColor] = useState(null)
  const [triangleSize, setTriangleSize] = useState(18)
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
  const [rotation, setRotation] = useState(90)
  // 画布显示缩放（仅影响展示尺寸）
  const [canvasScale, setCanvasScale] = useState(1)
  // 画布位置偏移（仅影响展示位置）
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 })
  const canvasWrapRef = useRef(null)
  const [solving, setSolving] = useState(false)
  // 自动求解步数上限（用于剪枝与性能控制），持久化到 localStorage
  const [maxStepsLimit, setMaxStepsLimit] = useState(() => {
    try { const v = localStorage.getItem('maxStepsLimit'); return v!=null ? parseInt(v,10) : 60 } catch { return 60 }
  })
  useEffect(()=>{ try{ localStorage.setItem('maxStepsLimit', String(maxStepsLimit)) }catch{} }, [maxStepsLimit])
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
  // 自动求解进度（显示实时状态）
  const [solveProgress, setSolveProgress] = useState(null)
  // 实时滚动小窗口：进度日志
  const [progressLogs, setProgressLogs] = useState([])

  const canvasRef = useRef(null)
  const progressLastRef = useRef(0)
  const solveStartRef = useRef(0)
  const progressLogRef = useRef(null)
  const importRef = useRef(null)

  // 初次加载时展示占位网格，避免空白画布
  useEffect(() => {
    if (imgBitmap || grid) return
    const w = 1600, h = 1200
    const g = buildTriangleGrid(w, h, triangleSize)
    setGrid(g)
    const tris = g.triangles.map(t => ({ ...t, color: (t.up ?? t.left) ? '#1b2333' : '#121826' }))
    setTriangles(tris)
  }, [imgBitmap])

  const handleImage = useCallback(async (blob) => {
    // 尊重 EXIF 方向，确保宽高与物理图像一致，避免比例失真
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    setImgBitmap(bitmap)
    const { palette } = await quantizeImage(bitmap)
    setPalette(palette)
    setInitialPalette(palette)
    setSelectedColor(palette[0] ?? null)
    setInitialSelectedColor(palette[0] ?? null)

    const w = bitmap.width
    const h = bitmap.height
    // 自动微调三角形尺寸：当使用默认值时，根据图像短边计算，使列/行数更合理，比例更稳定
    let side = triangleSize
    const DEFAULT_SIDE = 18
    if (triangleSize === DEFAULT_SIDE) {
      const short = Math.min(w, h)
      // 目标：短边约 60 个半边间距（列/行密度），确保采样密度随图像尺度自适应
      const targetAcrossShort = 60
      side = Math.max(10, Math.min(40, Math.round((2 * short) / targetAcrossShort)))
    }
    const grid = buildTriangleGrid(w, h, side)
    if (side !== triangleSize) {
      // 同步 UI 滑块显示，但保留用户后续手动可再调整
      setTriangleSize(side)
    }
    setGrid(grid)

    const mapped = await mapImageToGrid(bitmap, grid, palette)
    setTriangles(mapped)
    setStatus('已识别颜色并生成网格')
    setUndoStack([mapped.map(t => t.color)])
    setRedoStack([])
    setStartId(null)
    setSelectedIds([])
    setSteps([])
    setEditMode(true)
  }, [triangleSize])

  useEffect(() => {
    // 根据分离强度调节颜色匹配参数
    const penalty = colorSeparation
    const margin = 1.2 + 0.2 * colorSeparation
    const strongB = 10 + Math.max(0, colorSeparation - 4)
    setColorTuning({ GREY_PENALTY_BASE: penalty, WARM_MARGIN: margin, STRONG_B_TH: strongB })
    // 若处于导入工程状态，则不触发自动重建与重新识别
    if (loadedProject) return
    // 关键保护：用户开始试玩（editMode=false）后，调色板变化不再自动重映射，避免覆盖已泼涂颜色
    if (imgBitmap && palette.length && editMode) {
      const w = imgBitmap.width
      const h = imgBitmap.height
      const grid = buildTriangleGrid(w, h, triangleSize)
      setGrid(grid)
      ;(async () => {
        const mapped = await mapImageToGrid(imgBitmap, grid, palette)
        setTriangles(mapped)
        setUndoStack([mapped.map(t => t.color)])
        setRedoStack([])
        setStartId(null)
        setSteps([])
      })()
    } else if (!imgBitmap) {
      // 占位画布场景：允许三角形尺寸变化时重建网格，以便看到尺寸变化效果
      const w = grid?.width || 800
      const h = grid?.height || 600
      const g = buildTriangleGrid(w, h, triangleSize)
      setGrid(g)
      const base = g.triangles.map(t => ((t.up ?? t.left) ? '#1b2333' : '#121826'))
      setTriangles(g.triangles.map((t, i) => ({ ...t, color: base[i] })))
      // 记录初始快照，用于重置
      setUndoStack([base])
      setRedoStack([])
      setInitialPalette(palette)
      setInitialSelectedColor(palette[0] ?? null)
    }
  }, [triangleSize, loadedProject, colorSeparation, imgBitmap, editMode])

  // 将缩放系数写入 CSS 变量，供画布样式使用
  useEffect(() => {
    try { document.documentElement.style.setProperty('--canvas-scale', String(canvasScale)) } catch {}
  }, [canvasScale])

  // 将画布偏移写入 CSS 变量（支持键盘平移）
  useEffect(() => {
    try {
      document.documentElement.style.setProperty('--canvas-offset-x', `${canvasOffset.x}px`)
      document.documentElement.style.setProperty('--canvas-offset-y', `${canvasOffset.y}px`)
    } catch {}
  }, [canvasOffset])

  // 键盘平移：WASD 与方向键（按缩放系数调整步长）
  useEffect(() => {
    const onKeyPan = (e) => {
      const target = e.target
      const tag = target?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable
      if (isTyping) return
      const key = e.key
      const step = 40 / (canvasScale || 1)
      let dx = 0, dy = 0
      if (key === 'ArrowLeft' || key === 'a' || key === 'A') dx = -step
      else if (key === 'ArrowRight' || key === 'd' || key === 'D') dx = step
      else if (key === 'ArrowUp' || key === 'w' || key === 'W') dy = -step
      else if (key === 'ArrowDown' || key === 's' || key === 'S') dy = step
      if (dx !== 0 || dy !== 0) {
        e.preventDefault()
        setCanvasOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }))
      }
    }
    window.addEventListener('keydown', onKeyPan)
    return () => window.removeEventListener('keydown', onKeyPan)
  }, [canvasScale])

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

  const computeGreedyPath = useCallback((tris, pal, startIdLocal, limit) => {
    const idToIndex = new Map(tris.map((t, i) => [t.id, i]))
    const neighbors = tris.map(t => t.neighbors)
    const colors = tris.map(t => t.color)
    let region = computeRegion(colors, startIdLocal, idToIndex, neighbors)
    const path = []
    let guard = 0
    while (!isUniformColors(colors, tris) && path.length < limit && guard < 5000) {
      guard++
      const curColor = colors[idToIndex.get(startIdLocal)]
      let best = null, bestSize = -1
      for (const c of pal) {
        if (!c || c === curColor) continue
        const size = expandedSize(colors, region, neighbors, c, idToIndex)
        if (size > bestSize) { bestSize = size; best = c }
      }
      if (!best) break
      for (const id of region) { colors[idToIndex.get(id)] = best }
      region = computeRegion(colors, startIdLocal, idToIndex, neighbors)
      path.push(best)
    }
    return path
  }, [computeRegion, expandedSize, isUniformColors])

  const onSolve = useCallback(async () => {
    try {
      if (editMode) { setStatus('请先保存编辑，再进行自动求解'); return }
      if (triangles.length === 0) { setStatus('当前画布为空，无法求解'); return }
      if (!palette || palette.length < 2) { setStatus('调色板颜色不足，无法求解'); return }
      setSolving(true)
      setStatus('正在计算最少步骤（自动选择起点）…')
      setSolveProgress({ phase: 'init' })
      setProgressLogs([])
      solveStartRef.current = Date.now()
      // 让出一次事件循环，确保“计算中…”与状态文案先渲染
      await new Promise(r => setTimeout(r, 0))
      const maxBranches = 3
      // 仅使用本地计算：优先 Web Worker，失败则回退主线程
      let result = null
      if (!result) {
        try {
          const worker = new Worker(new URL('./utils/solver-worker.js', import.meta.url), { type: 'module' })
          try { window.__solverWorker = worker } catch {}
          const resPromise = new Promise((resolve, reject)=>{
            // 将 Worker 超时提升到 5 分钟以匹配计算预算
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
              setStatus(`正在计算最少步骤… ${phase}`)
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
              // 记录日志（滚动窗口显示）
              const perf = p?.perf || {}
              const phaseRaw = p?.phase || 'search'
              const compInfo = (phaseRaw==='components' || phaseRaw==='components_build')
                ? ` count=${p?.count??0}${p?.compSize!=null?` compSize=${p.compSize}`:''}`
                : ''
              const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phaseRaw}${compInfo} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
              setProgressLogs(prev=>{
                const next = [...prev, line]
                return next.length>200 ? next.slice(next.length-200) : next
              })
              progressLastRef.current = now
            }
          } else if(type==='result'){
                clearTimeout(timeout)
                try{ worker.terminate() }catch{}
                try{ window.__solverWorker = null }catch{}
                resolve(payload)
              }
            }
          })
          // 先同步求解器参数（flags），再启动自动求解
          try { worker.postMessage({ type:'set_flags', flags: window.SOLVER_FLAGS }) } catch {}
          worker.postMessage({ type:'auto', triangles, palette, maxBranches, stepLimit: maxStepsLimit })
          result = await resPromise
        } catch (wErr) {
          try{ window.__solverWorker = null }catch{}
          // 回退：使用窗口内的自动求解器
          result = await window.Solver_minStepsAuto?.(triangles, palette, maxBranches, (p)=>{
            const now = Date.now()
            if (now - progressLastRef.current > 200) {
            const nodes = p?.nodes ?? 0
            const sols = p?.solutions ?? 0
            const phase = p?.phase === 'components' ? `已识别连通分量：${p?.count}`
              : p?.phase === 'components_build' ? `正在构建分量：${p?.count}（当前大小 ${p?.compSize??'-'}）`
              : p?.phase === 'best_update' ? `已更新最优：起点 #${p?.bestStartId}，最少步骤 ${p?.minSteps}`
              : `已探索节点：${nodes}，候选分支：${sols}`
            setStatus(`正在计算最少步骤… ${phase}`)
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
            const phaseRaw2 = p?.phase || 'search'
            const compInfo2 = (phaseRaw2==='components' || phaseRaw2==='components_build')
              ? ` count=${p?.count??0}${p?.compSize!=null?` compSize=${p.compSize}`:''}`
              : ''
            const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phaseRaw2}${compInfo2} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
            setProgressLogs(prev=>{
              const next = [...prev, line]
              return next.length>200 ? next.slice(next.length-200) : next
            })
            progressLastRef.current = now
          }
        }, maxStepsLimit)
        }
      }
      // 严格审核：仅允许输出最终颜色统一的方案
      const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
      const neighbors = triangles.map(t=>t.neighbors)
      const checkUnified = (path)=>{
        let colors = triangles.map(t=>t.color)
        const startIdLocal = result.bestStartId
        for(const color of path){
          const startColorCur = colors[idToIndex.get(startIdLocal)]
          if(color===startColorCur) continue
          const regionSet = new Set(); const q=[startIdLocal]; const visited=new Set([startIdLocal])
          while(q.length){
            const id=q.shift(); const idx=idToIndex.get(id)
            if(colors[idx]!==startColorCur) continue
            regionSet.add(id)
            for(const nb of neighbors[idx]){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } }
          }
          for(const id of regionSet){ colors[idToIndex.get(id)] = color }
        }
        const finalTris = triangles.map((t,i)=>({ ...t, color: colors[i] }))
        return isUniform(finalTris)
      }
      const unifiedPaths = (result?.paths||[]).filter(p=>checkUnified(p))
      if (!result || unifiedPaths.length === 0 || !result.bestStartId) {
        const startIdLocal = (result?.bestStartId!=null) ? result.bestStartId : (startId!=null ? startId : pickHeuristicStartId(triangles))
        const heurLimit = Math.max(1, Math.min(40, maxStepsLimit))
        const heurPath = computeGreedyPath(triangles, palette, startIdLocal, heurLimit)
        if (heurPath && heurPath.length) {
          const snapshots = await captureCanvasPNG(canvasRef.current, triangles, startIdLocal, heurPath)
          setSteps([{ path: heurPath, images: snapshots }])
          setStatus(`超时或未统一，已给出接近方案：起点 #${startIdLocal}，步骤 ${heurPath.length}`)
          setSolveProgress(null)
          return
        }
        setStatus('未能在上限内统一，也无法生成接近方案。请提高步数上限或重试。')
        setSolveProgress(null)
        return
      }
      if (!result || result.paths.length === 0 || !result.bestStartId) {
        if (result?.timedOut) {
          setStatus('提示：计算时间超出预算或达到上限，已提前停止。可尝试减小图片尺寸、降低三角形数量或提高预算。')
        } else {
          setStatus('未找到可行解或超出计算上限')
        }
        setSolveProgress(null)
        return
      }
      const stepImgs = []
      const SNAPSHOT_LIMIT = 40
      for (const path of unifiedPaths) {
        setStatus(`正在生成步骤快照… (${stepImgs.length+1}/${result.paths.length})`)
        const snapshots = await captureCanvasPNG(canvasRef.current, triangles, result.bestStartId, path.slice(0, SNAPSHOT_LIMIT))
        stepImgs.push({ path, images: snapshots })
        await new Promise(r=>setTimeout(r,0))
      }
      setSteps(stepImgs)
      setBestStartId(result.bestStartId ?? null)
      setStatus(`计算完成（自动起点 #${result.bestStartId}），最少步骤：${result.minSteps}，合格分支：${unifiedPaths.length}`)
      setSolveProgress(null)
    } catch (err) {
      console.error('Auto-solve error:', err)
      setStatus('求解过程中发生错误')
    } finally {
      setSolving(false)
    }
  }, [triangles, palette, editMode, maxStepsLimit])

  // 继续计算最短步骤：在已有可行方案基础上，切换到 BFS/Best-First 求全局最短
  const onContinueShortest = useCallback(async () => {
    try {
      if (editMode) { setStatus('请先保存编辑，再继续计算最短步骤'); return }
      if (!steps || steps.length === 0) { setStatus('暂无可行方案，先执行自动求解'); return }
      setSolving(true)
      setStatus('正在继续计算最短步骤…')
      setSolveProgress({ phase: 'init' })
      setProgressLogs([])
      solveStartRef.current = Date.now()
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
                setStatus(`正在继续计算最短步骤… ${phase}`)
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
                const phaseRaw3 = p?.phase || 'search'
                const compInfo3 = (phaseRaw3==='components' || phaseRaw3==='components_build')
                  ? ` count=${p?.count??0}${p?.compSize!=null?` compSize=${p.compSize}`:''}`
                  : ''
                const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phaseRaw3}${compInfo3} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
                setProgressLogs(prev=>{
                  const next = [...prev, line]
                  return next.length>200 ? next.slice(next.length-200) : next
                })
                progressLastRef.current = now
              }
            } else if(type==='result'){
              clearTimeout(timeout)
              try{ worker.terminate() }catch{}
              try{ window.__solverWorker = null }catch{}
              resolve(payload)
            }
          }
        })
        // 覆写 flags：关闭 DFS 与早停，采用标准 BFS/Best-First 求最短
        const flags = { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false }
        try { worker.postMessage({ type:'set_flags', flags }) } catch {}
        worker.postMessage({ type:'auto', triangles, palette, maxBranches, stepLimit: maxStepsLimit })
        result = await resPromise
      } catch (err) {
        try{ window.__solverWorker = null }catch{}
        // 回退到主线程
        result = await window.Solver_minStepsAuto?.(triangles, palette, 3, (p)=>{
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
            const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${p?.phase||'search'} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
            setProgressLogs(prev=>{ const next=[...prev,line]; return next.length>200 ? next.slice(next.length-200) : next })
            progressLastRef.current = now
          }
        }, maxStepsLimit)
      }

      // 最终展示最短方案
      const idToIndex = new Map(triangles.map((t,i)=>[t.id,i]))
      const neighbors = triangles.map(t=>t.neighbors)
      const checkUnified = (path)=>{
        let colors = triangles.map(t=>t.color)
        const startIdLocal = result.bestStartId
        for(const color of path){
          const startColorCur = colors[idToIndex.get(startIdLocal)]
          if(color===startColorCur) continue
          const regionSet = new Set(); const q=[startIdLocal]; const visited=new Set([startIdLocal])
          while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colors[idx]!==startColorCur) continue; regionSet.add(id); for(const nb of neighbors[idx]){ if(!visited.has(nb)){ visited.add(nb); q.push(nb) } } }
          for(const id of regionSet){ colors[idToIndex.get(id)] = color }
        }
        const finalTris = triangles.map((t,i)=>({ ...t, color: colors[i] }))
        return isUniform(finalTris)
      }
      const unifiedPaths = (result?.paths||[]).filter(p=>checkUnified(p))
      if (!result || unifiedPaths.length === 0 || !result.bestStartId) {
        setStatus('继续计算最短步骤失败或未统一，请重试')
        setSolveProgress(null)
        return
      }
      const stepImgs = []
      const SNAPSHOT_LIMIT = 40
      for (const path of unifiedPaths) {
        setStatus(`正在生成步骤快照… (${stepImgs.length+1}/${result.paths.length})`)
        const snapshots = await captureCanvasPNG(canvasRef.current, triangles, result.bestStartId, path.slice(0, SNAPSHOT_LIMIT))
        stepImgs.push({ path, images: snapshots })
        await new Promise(r=>setTimeout(r,0))
      }
      setSteps(stepImgs)
      setBestStartId(result.bestStartId ?? null)
      setStatus(`已更新为最短步骤（自动起点 #${result.bestStartId}），最少步骤：${result.minSteps}`)
      setSolveProgress(null)
    } catch (err) {
      console.error('Continue shortest error:', err)
      setStatus('继续计算最短步骤时发生错误')
    } finally {
      setSolving(false)
    }
  }, [steps, triangles, palette, editMode, maxStepsLimit, bestStartId])

  // 路径优化（反思/压缩）：利用 OptimizeSolution 分析关键节点并尝试缩短
  const onOptimizePath = useCallback(async () => {
    try {
      if (!steps || steps.length === 0) { setStatus('暂无可行方案，先执行自动求解'); return }
      const originalPath = steps[0]?.path
      const sid = bestStartId ?? pickHeuristicStartId(triangles)
      setSolving(true)
      setStatus('正在进行路径优化（反思 / 拆解 / 压缩）…')
      setSolveProgress({ phase: 'optimize_init' })
      setProgressLogs([])
      solveStartRef.current = Date.now()
      await new Promise(r=>setTimeout(r,0))
      let result = null
      try {
        const worker = new Worker(new URL('./utils/solver-worker.js', import.meta.url), { type: 'module' })
        try { window.__solverWorker = worker } catch {}
        const resPromise = new Promise((resolve, reject)=>{
          const timeout = setTimeout(()=>{ try{ worker.terminate() }catch{}; try{ window.__solverWorker = null }catch{}; reject(new Error('worker-timeout')) }, 180000)
          worker.onmessage = (ev)=>{
            const { type, payload } = ev.data || {}
            if(type==='progress'){
              const p = payload
              const now = Date.now()
              if (now - progressLastRef.current > 200) {
                const phase = p?.phase || 'optimize'
                setStatus(`正在路径优化… 阶段：${phase}`)
                setSolveProgress({ phase, criticalCount: p?.criticalCount, minSteps: p?.minSteps, components: p?.count })
                const perf = p?.perf || {}
                const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phase} crit=${p?.criticalCount??'-'} min=${p?.minSteps??'-'} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'}`
                setProgressLogs(prev=>{ const next=[...prev,line]; return next.length>200 ? next.slice(next.length-200) : next })
                progressLastRef.current = now
              }
            } else if(type==='result'){
              clearTimeout(timeout)
              try{ worker.terminate() }catch{}
              try{ window.__solverWorker = null }catch{}
              resolve(payload)
            }
          }
        })
        // 确保使用 DFS-first 与早停寻找更短路径
        const flags = { ...(window.SOLVER_FLAGS||{}), useDFSFirst: true, returnFirstFeasible: true }
        try { worker.postMessage({ type:'set_flags', flags }) } catch {}
        worker.postMessage({ type:'optimize', triangles, palette, startId: sid, path: originalPath })
        result = await resPromise
      } catch (err) {
        try{ window.__solverWorker = null }catch{}
        // 回退：主线程路径优化
        result = await window.OptimizeSolution?.(triangles, palette, sid, originalPath, (p)=>{
          const now = Date.now()
          const phase = p?.phase || 'optimize'
          if (now - progressLastRef.current > 200) {
            setStatus(`正在路径优化… 阶段：${phase}`)
            setSolveProgress({ phase, criticalCount: p?.criticalCount, minSteps: p?.minSteps })
            const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phase} crit=${p?.criticalCount??'-'} min=${p?.minSteps??'-'}`
            setProgressLogs(prev=>{ const next=[...prev,line]; return next.length>200 ? next.slice(next.length-200) : next })
            progressLastRef.current = now
          }
        })
      }
      if (!result) { setStatus('路径优化失败'); setSolveProgress(null); return }
      // 本地统一性校验：仅在“更短且统一”时替换展示
      const checkUniformPath = (tris, startIdLocal, pathLocal)=>{
        const idToIndex = new Map(tris.map((t,i)=>[t.id,i]))
        const neighbors = tris.map(t=>t.neighbors)
        const isUniformFast = (colorsArr)=>{
          let first=null
          for(let i=0;i<tris.length;i++){ const t=tris[i]; const c=colorsArr[i]; if(t.deleted || !c || c==='transparent') continue; if(first===null){ first=c } else if(c!==first){ return false } }
          return first!==null
        }
        let colorsLocal = tris.map(t=>t.color)
        const buildRegion = (colorsArr)=>{ const rc = colorsArr[idToIndex.get(startIdLocal)]; const rs=new Set(); const q=[startIdLocal]; const v=new Set([startIdLocal]); while(q.length){ const id=q.shift(); const idx=idToIndex.get(id); if(colorsArr[idx]!==rc) continue; rs.add(id); for(const nb of neighbors[idx]){ if(!v.has(nb)){ v.add(nb); q.push(nb) } } } return rs }
        for(const stepColor of pathLocal){ const reg = buildRegion(colorsLocal); for(const id of reg){ colorsLocal[idToIndex.get(id)] = stepColor } }
        return isUniformFast(colorsLocal)
      }
      const isUniformOut = Array.isArray(result.optimizedPath)
        ? checkUniformPath(triangles, result.bestStartId ?? sid, result.optimizedPath)
        : false
      if (result.shortened && result.optimizedPath && result.optimizedLen < (originalPath?.length||Infinity) && isUniformOut){
        // 生成新的快照
        const SNAPSHOT_LIMIT = 40
        const snapshots = await captureCanvasPNG(canvasRef.current, triangles, result.bestStartId ?? sid, result.optimizedPath.slice(0, SNAPSHOT_LIMIT))
        setSteps([{ path: result.optimizedPath, images: snapshots }])
        setBestStartId(result.bestStartId ?? sid)
        setStatus(`路径优化成功：由 ${originalPath.length} 步缩短为 ${result.optimizedLen} 步（起点 #${result.bestStartId ?? sid}）`)
      } else {
        setStatus('未发现更短且统一的路径（已完成关键节点分析，可查看日志）')
      }
      setSolveProgress(null)
    } catch (err) {
      console.error('Optimize path error:', err)
      setStatus('路径优化时发生错误')
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
  }, [grid, triangles, palette, selectedColor])

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

  return (
    <div className="app">
      <div className="panel upload">
        <h2>上传图片 / 截图</h2>
        <UploadPanel onImage={handleImage} />
        <div className="status">{status}</div>
      </div>

      {/* 顶部右上角说明入口 */}
      <a href="#/help" className="help-link" style={{ position:'fixed', top:'12px', right:'16px', color:'var(--muted)', textDecoration:'none' }}>说明</a>

      <div className="panel">
        <h2>画布</h2>
        <div className="canvas-wrap" ref={canvasWrapRef}>
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
        <div className="toolbar" style={{ marginTop: '.75rem' }}>
          <button className="primary" onClick={onPaint} disabled={!selectedColor || startId==null}>泼涂</button>
          <button onClick={onUndo}>撤销</button>
          <button onClick={onRedo}>重做</button>
          <button onClick={onSelectSameColor} disabled={triangles.length===0}>选择同色</button>
          <button onClick={onBulkReplaceToSelected} disabled={!selectedColor || selectedIds.length===0}>批量替换为选色</button>
          <button onClick={onSolve} disabled={solving || triangles.length===0}>{solving ? '计算中…' : '自动求解'}</button>
          <span style={{ marginLeft: '.5rem', display:'inline-flex', alignItems:'center', gap:'.25rem', color:'#a9b3c9' }}>
            <label htmlFor="stepLimit">步数上限</label>
            <input
              id="stepLimit"
              type="number"
              min={1}
              max={200}
              value={maxStepsLimit}
              onChange={(e)=>{
                const v = parseInt(e.target.value, 10)
                setMaxStepsLimit(Number.isFinite(v) ? Math.max(1, Math.min(200, v)) : 60)
              }}
              style={{ width:'64px', padding:'2px 6px', borderRadius:'6px', border:'1px solid var(--border)', background:'#1a1f2b', color:'var(--text)' }}
              title="自动求解最多执行的步骤数量，越小越快"
            />
          </span>
          {editMode ? (
            <>
              <button onClick={onDeleteSelected} disabled={selectedIds.length===0}>删除选中（{selectedIds.length}）</button>
              <button onClick={onSaveEdit}>保存编辑</button>
            </>
          ) : (
            <button onClick={onEnterEdit}>进入编辑</button>
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
        />
        <div className="grid-controls">
          <div className="row">
            <label>三角形尺寸</label>
            <input
              type="range"
              min="10"
              max="40"
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
            <input type="range" min="0.4" max="2" step="0.05" value={canvasScale} onChange={e=>setCanvasScale(+e.target.value)} />
            <span>{Math.round(canvasScale*100)}%</span>
          </div>
          <div className="row">
            <label>网格旋转</label>
            <button onClick={()=>setRotation(r=> (r===0?90:0))}>{rotation===0? '旋转90°':'还原0°'}</button>
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
    </div>
  )
}

export default App
