import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

import UploadPanel from './components/UploadPanel'
import TriangleCanvas from './components/TriangleCanvas'
import Controls from './components/Controls'
import StepsPanel from './components/StepsPanel'
import HelpPage from './components/HelpPage'
import CentralHub from './components/CentralHub'
import AdminDashboard from './components/AdminDashboard'

import { quantizeImage, setColorTuning } from './utils/color-utils'
import { buildTriangleGrid, buildTriangleGridVertical, mapImageToGrid, isUniform, colorFrequency } from './utils/grid-utils'
import { floodFillRegion, attachSolverToWindow, captureCanvasPNG } from './utils/solver'
import { hasPDB, loadPDBObject, loadPDBFromJSON, loadPDBFromURL, getPDBBaseURL } from './utils/pdb'
import { startRun as telemetryStartRun, logEvent as telemetryLogEvent, finishRun as telemetryFinishRun, makeGraphSignature, getRecommendation, getCachePath, putCachePath, uploadStrategyAuto } from './utils/telemetry'

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
    enableLookaheadDepth2: false,
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
    strictMode: false,
    logPerf: true,
    // 学习优先级与 SAT 宏规划
    enableLearningPrioritizer: true,
    enableSATPlanner: false,
    // 后端遥测开关与服务地址
    enableTelemetry: true,
    serverBaseUrl: serverBaseDefault,
    // 进度与时间预算
    workerTimeBudgetMs: 300000,
    parallelWorkers: 3,
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
  // 强制开启遥测：不受持久化配置影响，确保自动上传策略与学习统计
  try {
    window.SOLVER_FLAGS.enableTelemetry = true
    // 写回本地，避免旧配置残留导致后续会话关闭遥测
    const persistedNext = { ...(persisted||{}), enableTelemetry: true }
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

function App() {
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
  const [rotation, setRotation] = useState(0)
  // 网格排列方向：horizontal（底边水平）/ vertical（底边竖直）
  const [gridArrangement, setGridArrangement] = useState('horizontal')
  // 网格分辨率因子：实际用于构建网格的边长 = 基础尺寸 / 分辨率因子
  const [resolutionScale, setResolutionScale] = useState(1)
  // 画布显示缩放（仅影响展示尺寸）
  const [canvasScale, setCanvasScale] = useState(1)
  // 画布位置偏移（仅影响展示位置）
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 })
  const canvasWrapRef = useRef(null)
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
      const cw = swap ? grid.height : grid.width
      const ch = swap ? grid.width : grid.height
      const ww = wrap.clientWidth
      const wh = wrap.clientHeight
      if (ww <= 0 || wh <= 0 || cw <= 0 || ch <= 0) return
      const s = canvasScale || 1
      const ox = (ww - cw * s) / 2
      const oy = (wh - ch * s) / 2
      setCanvasOffset({ x: ox, y: oy })
    } catch {}
  }, [grid, rotation, canvasScale])

  // 初次加载时展示占位网格，避免空白画布
  useEffect(() => {
    if (imgBitmap || grid) return
    const wrap = canvasWrapRef.current
    const w = wrap?.clientWidth || 1600
    const h = wrap?.clientHeight || 1200
    const sideInit = triangleSize / (resolutionScale || 1)
    const g = (gridArrangement === 'horizontal')
      ? buildTriangleGrid(w, h, sideInit)
      : buildTriangleGridVertical(w, h, sideInit)
    setGrid(g)
    const tris = g.triangles.map(t => ({ ...t, color: (t.up ?? t.left) ? '#1b2333' : '#121826' }))
    setTriangles(tris)
  }, [imgBitmap, gridArrangement, triangleSize, resolutionScale])

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
    let sideBase = triangleSize
    const DEFAULT_SIDE = 18
    if (triangleSize === DEFAULT_SIDE) {
      const short = Math.min(w, h)
      // 目标：短边约 90 个半边间距（更细密，减少形状“变形”感）
      const targetAcrossShort = 90
      // 放宽自适应范围：6~60
      sideBase = Math.max(6, Math.min(60, Math.round((2 * short) / targetAcrossShort)))
    }
    const side = sideBase / (resolutionScale || 1)
    const grid = (gridArrangement === 'horizontal')
      ? buildTriangleGrid(w, h, side)
      : buildTriangleGridVertical(w, h, side)
    if (sideBase !== triangleSize) {
      // 同步 UI 滑块显示，但保留用户后续手动可再调整
      setTriangleSize(sideBase)
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
  }, [triangleSize, gridArrangement, resolutionScale])

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
          const w = imgBitmap.width
          const h = imgBitmap.height
          const gridNew = (gridArrangement === 'horizontal')
            ? buildTriangleGrid(w, h, triangleSize / (resolutionScale || 1))
            : buildTriangleGridVertical(w, h, triangleSize / (resolutionScale || 1))
          setGrid(gridNew)
          const mapped = await mapImageToGrid(imgBitmap, gridNew, palette)
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
            ? buildTriangleGrid(w, h, triangleSize / (resolutionScale || 1))
            : buildTriangleGridVertical(w, h, triangleSize / (resolutionScale || 1))
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
  }, [triangleSize, gridArrangement, resolutionScale, loadedProject, colorSeparation, imgBitmap, editMode])

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

  // Ctrl+滚轮缩放：向下滚轮放大，向上缩小（锚定指针位置）
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
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = wrap.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setCanvasScale(prev => {
        const rawNext = prev * (e.deltaY < 0 ? 1.12 : 0.88)
        const next = Math.max(0.1, Math.min(6, rawNext))
        setCanvasOffset(offPrev => {
          const Px = (cx - offPrev.x) / prev
          const Py = (cy - offPrev.y) / prev
          return { x: cx - Px * next, y: cy - Py * next }
        })
        return next
      })
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [getMinScale])

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
      if (key === 'ArrowLeft') dx = -step
      else if (key === 'ArrowRight') dx = step
      else if (key === 'a' || key === 'A') dx = step
      else if (key === 'd' || key === 'D') dx = -step
      else if (key === 'ArrowUp') dy = -step
      else if (key === 'ArrowDown') dy = step
      else if (key === 'w' || key === 'W') dy = step
      else if (key === 's' || key === 'S') dy = -step
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
      // 启动遥测 Run（不阻塞求解）
      const graphSignature = makeGraphSignature(triangles, palette)
      let __runId = null
      try { const __r = await telemetryStartRun(triangles, palette, window.SOLVER_FLAGS); __runId = __r?.runId || null } catch {}
      const telemetrySafeLog = async (payload)=>{ try{ if(__runId) await telemetryLogEvent(__runId, payload) }catch{} }
      // 让出一次事件循环，确保“计算中…”与状态文案先渲染
      await new Promise(r => setTimeout(r, 0))
      // 优先尝试缓存命中
      try {
        const cache = await getCachePath(graphSignature)
        const cachedPath = cache?.path
        const cachedStart = cache?.start_id
        const cachedMin = cache?.min_steps
        if (cachedPath && cachedPath.length>0 && cachedStart!=null) {
          const snapshots = await captureCanvasPNG(canvasRef.current, triangles, cachedStart, cachedPath.slice(0, Math.max(1, Math.min(40, cachedPath.length))))
          setSteps([{ path: cachedPath, images: snapshots }])
          setBestStartId(cachedStart)
          setStatus(`缓存命中：起点 #${cachedStart}，步骤 ${cachedMin??cachedPath.length}`)
          setSolveProgress(null)
          try { if(__runId) await telemetryFinishRun(__runId, { status:'cache_hit', min_steps: cachedMin??cachedPath.length, best_start_id: cachedStart, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
          try { await uploadStrategyAuto(triangles, palette, 'auto_solve', cachedStart, cachedPath) } catch {}
          return
        }
      } catch {}
      // 获取推荐参数与优先起点
      let preferredStartId = null
      try {
        const rec = await getRecommendation(graphSignature)
        if (rec?.flags_overrides) { window.SOLVER_FLAGS = { ...(window.SOLVER_FLAGS||{}), ...(rec.flags_overrides||{}) } }
        if (rec?.start_id!=null) { window.SOLVER_FLAGS.preferredStartId = rec.start_id; preferredStartId = rec.start_id }
        if (typeof rec?.lb_estimate==='number') { telemetrySafeLog({ phase:'recommend', extra: { lb_estimate: rec.lb_estimate } }) }
      } catch {}
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
                const flags = (window.SOLVER_FLAGS||{})
                const compPhases = ['components','components_build','components_analysis']
                const strictPhases = ['strict_astar']
                const intervalCfg = compPhases.includes(p?.phase)
                  ? (flags.progressComponentsIntervalMs ?? 0)
                  : strictPhases.includes(p?.phase)
                    ? (flags.progressAStarIntervalMs ?? 80)
                    : (flags.progressDFSIntervalMs ?? 100)
                if (intervalCfg===0 || (now - progressLastRef.current) >= intervalCfg) {
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
              // 发送进度遥测（后端 events）
              telemetrySafeLog({
                phase: p?.phase,
                nodes: p?.nodes,
                solutions: p?.solutions,
                queue: p?.queue,
                perf: p?.perf,
                extra: { bestStartId: p?.bestStartId, minSteps: p?.minSteps, count: p?.count }
              })
              // 记录日志（滚动窗口显示）
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
                }
                return ''
              })()
              const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phaseRaw}${compInfo}${extra} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
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
          const flagsInitial = Number.isFinite(maxStepsLimit)
            ? { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false, useStrongLBInBestFirst: true, enableBeam: true, beamWidth: Math.max(24, window.SOLVER_FLAGS?.beamWidth ?? 32), beamMin: Math.max(10, window.SOLVER_FLAGS?.beamMin ?? 8), bifrontWeight: Math.max(2.2, window.SOLVER_FLAGS?.bifrontWeight ?? 2.0), rareAllowBridgeMin: Math.max(2.2, window.SOLVER_FLAGS?.rareAllowBridgeMin ?? 2.0), rareAllowGateMin: Math.max(1.2, window.SOLVER_FLAGS?.rareAllowGateMin ?? 1.0), lbImproveMin: Math.max(2, window.SOLVER_FLAGS?.lbImproveMin ?? 1) }
            : (window.SOLVER_FLAGS||{})
          try { worker.postMessage({ type:'set_flags', flags: flagsInitial }) } catch {}
          const lightTris = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
          worker.postMessage({ type:'auto', triangles: lightTris, palette, maxBranches, stepLimit: maxStepsLimit, preferredStartId })
          result = await resPromise
        } catch (wErr) {
          try{ window.__solverWorker = null }catch{}
          // 回退：使用窗口内的自动求解器
          const lightTris2 = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
          result = await window.Solver_minStepsAuto?.(lightTris2, palette, maxBranches, (p)=>{
            const now = Date.now()
            const flags = (window.SOLVER_FLAGS||{})
            const compPhases = ['components','components_build','components_analysis']
            const strictPhases = ['strict_astar']
            const intervalCfg = compPhases.includes(p?.phase)
              ? (flags.progressComponentsIntervalMs ?? 0)
              : strictPhases.includes(p?.phase)
                ? (flags.progressAStarIntervalMs ?? 80)
                : (flags.progressDFSIntervalMs ?? 100)
            if (intervalCfg===0 || (now - progressLastRef.current) >= intervalCfg) {
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
                const extra2 = (function(){
                  if (phaseRaw2==='branch_pruned') {
                    return ` reason=${p?.reason??'-'} step=${p?.step??'-'} color=${p?.color??'-'}`
                  } else if (phaseRaw2==='branch_quality') {
                    const dr = (typeof p?.deltaRatio==='number') ? (p.deltaRatio.toFixed(3)) : (p?.deltaRatio??'-')
                    return ` step=${p?.step??'-'} color=${p?.color??'-'} delta=${p?.delta??'-'} dr=${dr} lb=${p?.lb??'-'} prio=${p?.priority??'-'}`
                  } else if (phaseRaw2==='components_analysis') {
                    return ` count=${p?.count??0}`
                  }
                  return ''
                })()
                const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phaseRaw2}${compInfo2}${extra2} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
            setProgressLogs(prev=>{
              const next = [...prev, line]
              return next.length>200 ? next.slice(next.length-200) : next
            })
            progressLastRef.current = now
          }
        }, Number.isFinite(maxStepsLimit) ? maxStepsLimit : 80)
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
      let unifiedPaths = (result?.paths||[]).filter(p=>checkUnified(p))
      if (!result || unifiedPaths.length === 0 || !result.bestStartId) {
        const elapsed = Date.now() - solveStartRef.current
        const budget = (window.SOLVER_FLAGS?.workerTimeBudgetMs ?? 300000)
        if (elapsed < budget - 10000) {
          setStatus('未统一，继续搜索合格方案（桥接优先）…')
          try {
            const worker2 = new Worker(new URL('./utils/solver-worker.js', import.meta.url), { type: 'module' })
            try { window.__solverWorker = worker2 } catch {}
            const resPromise2 = new Promise((resolve, reject)=>{
              const timeout2 = setTimeout(()=>{ try{ worker2.terminate() }catch{}; try{ window.__solverWorker = null }catch{}; reject(new Error('worker-timeout')) }, Math.max(10000, budget - elapsed))
              worker2.onmessage = (ev)=>{
                const { type, payload } = ev.data || {}
                if(type==='progress'){
                  const p2 = payload
                  const now2 = Date.now()
                  const flags2 = (window.SOLVER_FLAGS||{})
                  const compPhases2 = ['components','components_build','components_analysis']
                  const strictPhases2 = ['strict_astar']
                  const intervalCfg2 = compPhases2.includes(p2?.phase)
                    ? (flags2.progressComponentsIntervalMs ?? 0)
                    : strictPhases2.includes(p2?.phase)
                      ? (flags2.progressAStarIntervalMs ?? 80)
                      : (flags2.progressDFSIntervalMs ?? 100)
                  if (intervalCfg2===0 || (now2 - progressLastRef.current) >= intervalCfg2) {
                    const nodes2 = p2?.nodes ?? 0
                    const sols2 = p2?.solutions ?? 0
                    const phase2 = p2?.phase === 'components' ? `已识别连通分量：${p2?.count}`
                      : p2?.phase === 'components_build' ? `正在构建分量：${p2?.count}（当前大小 ${p2?.compSize??'-'}）`
                      : p2?.phase === 'best_update' ? `已更新最优：起点 #${p2?.bestStartId}，最少步骤 ${p2?.minSteps}`
                      : `已探索节点：${nodes2}，候选分支：${sols2}`
                    setStatus(`正在继续搜索合格方案… ${phase2}`)
                    setSolveProgress({
                      phase: p2?.phase,
                      nodes: p2?.nodes,
                      solutions: p2?.solutions,
                      queue: p2?.queue,
                      components: p2?.count,
                      bestStartId: p2?.bestStartId,
                      minSteps: p2?.minSteps,
                      elapsedMs: now2 - solveStartRef.current,
                      perf: p2?.perf,
                    })
                    const perf2 = p2?.perf || {}
                    const phaseRaw2 = p2?.phase || 'search'
                    const compInfo2 = (phaseRaw2==='components' || phaseRaw2==='components_build')
                      ? ` count=${p2?.count??0}${p2?.compSize!=null?` compSize=${p2.compSize}`:''}`
                      : ''
                    const extra2 = (function(){
                      if (phaseRaw2==='branch_pruned') {
                        return ` reason=${p2?.reason??'-'} step=${p2?.step??'-'} color=${p2?.color??'-'}`
                      } else if (phaseRaw2==='branch_quality') {
                        const dr2 = (typeof p2?.deltaRatio==='number') ? (p2.deltaRatio.toFixed(3)) : (p2?.deltaRatio??'-')
                        return ` step=${p2?.step??'-'} color=${p2?.color??'-'} delta=${p2?.delta??'-'} dr=${dr2} lb=${p2?.lb??'-'} prio=${p2?.priority??'-'}`
                      } else if (phaseRaw2==='components_analysis') {
                        return ` count=${p2?.count??0}`
                      }
                      return ''
                    })()
                    const line2 = `[${((now2 - solveStartRef.current)/1000).toFixed(1)}s] phase=${phaseRaw2}${compInfo2}${extra2} nodes=${p2?.nodes??0} queue=${p2?.queue??0} sols=${p2?.solutions??0} enq=${perf2?.enqueued??'-'} exp=${perf2?.expanded??'-'} zf=${perf2?.filteredZero??'-'}`
                    setProgressLogs(prev=>{ const next=[...prev,line2]; return next.length>200 ? next.slice(next.length-200) : next })
                    progressLastRef.current = now2
                  }
                } else if(type==='result'){
                  clearTimeout(timeout2)
                  try{ worker2.terminate() }catch{}
                  try{ window.__solverWorker = null }catch{}
                  resolve(payload)
                }
              }
            })
            const flagsStrong = Number.isFinite(maxStepsLimit)
              ? { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false, useStrongLBInBestFirst: true, enableBridgeFirst: true, bifrontWeight: Math.max(2.2, (window.SOLVER_FLAGS?.bifrontWeight ?? 2.0)) }
              : { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false, enableBridgeFirst: true, bifrontWeight: Math.max(2, (window.SOLVER_FLAGS?.bifrontWeight ?? 2)) }
            try { worker2.postMessage({ type:'set_flags', flags: flagsStrong }) } catch {}
            const lightTrisX = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
            worker2.postMessage({ type:'auto', triangles: lightTrisX, palette, maxBranches, stepLimit: maxStepsLimit })
            const result2 = await resPromise2
            const unifiedPaths2 = (result2?.paths||[]).filter(p=>{
              let colors = triangles.map(t=>t.color)
              const startIdLocal2 = result2.bestStartId
              for(const color of p){
                const startColorCur2 = colors[idToIndex.get(startIdLocal2)]
                if(color===startColorCur2) continue
                const regionSet2 = new Set(); const q2=[startIdLocal2]; const visited2=new Set([startIdLocal2])
                while(q2.length){ const id=q2.shift(); const idx=idToIndex.get(id); if(colors[idx]!==startColorCur2) continue; regionSet2.add(id); for(const nb of neighbors[idx]){ if(!visited2.has(nb)){ visited2.add(nb); q2.push(nb) } } }
                for(const id of regionSet2){ colors[idToIndex.get(id)] = color }
              }
              const finalTris2 = triangles.map((t,i)=>({ ...t, color: colors[i] }))
              return isUniform(finalTris2)
            })
            if (result2 && unifiedPaths2.length>0 && result2.bestStartId!=null) {
              result = result2
              unifiedPaths = unifiedPaths2
            }
          } catch {}
        }
        if (!result || unifiedPaths.length === 0 || !result.bestStartId) {
          const startIdLocal = (result?.bestStartId!=null) ? result.bestStartId : (startId!=null ? startId : pickHeuristicStartId(triangles))
          const heurLimit = Number.isFinite(maxStepsLimit) ? Math.max(1, Math.min(40, maxStepsLimit)) : 40
          const heurPath = computeGreedyPath(triangles, palette, startIdLocal, heurLimit)
          if (heurPath && heurPath.length) {
            const snapshots = await captureCanvasPNG(canvasRef.current, triangles, startIdLocal, heurPath)
            setSteps([{ path: heurPath, images: snapshots }])
            setStatus(`超时或未统一，已给出接近方案：起点 #${startIdLocal}，步骤 ${heurPath.length}`)
            setSolveProgress(null)
            // 近似方案也上传策略摘要，并结束遥测 Run，确保总站可见
            try { await uploadStrategyAuto(triangles, palette, 'auto_solve_fallback', startIdLocal, heurPath) } catch {}
            try { if(__runId) await telemetryFinishRun(__runId, { status:'fallback', min_steps: heurPath.length, best_start_id: startIdLocal, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
            return
          }
          setStatus('未能在上限内统一，也无法生成接近方案。请提高步数上限或重试。')
          setSolveProgress(null)
          // 无解时亦上传空摘要并结束遥测，便于数据库与总站同步
          try { await uploadStrategyAuto(triangles, palette, 'auto_solve_failed', startIdLocal, []) } catch {}
          try { if(__runId) await telemetryFinishRun(__runId, { status:'no_solution', best_start_id: startIdLocal, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature }) } catch {}
          return
        }
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
      try { await putCachePath(graphSignature, { path: unifiedPaths[0]||[], min_steps: result.minSteps, start_id: result.bestStartId, flags: window.SOLVER_FLAGS }) } catch {}
      try { await uploadStrategyAuto(triangles, palette, 'auto_solve', result.bestStartId, unifiedPaths[0]||[]) } catch {}
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
    try {
      if (editMode) { setStatus('请先保存编辑，再继续计算最短步骤'); return }
      if (!steps || steps.length === 0) { setStatus('暂无可行方案，先执行自动求解'); return }
      setSolving(true)
      setStatus('正在继续计算最短步骤…')
      setSolveProgress({ phase: 'init' })
      setProgressLogs([])
      solveStartRef.current = Date.now()
      // 启动遥测 Run（不阻塞）与缓存优先
      const graphSignature2 = makeGraphSignature(triangles, palette)
      let __runId2 = null
      try { const __r2 = await telemetryStartRun(triangles, palette, { ...(window.SOLVER_FLAGS||{}), mode: 'continue_shortest' }); __runId2 = __r2?.runId || null } catch {}
      const telemetrySafeLog2 = async (payload)=>{ try{ if(__runId2) await telemetryLogEvent(__runId2, payload) }catch{} }
      // 尝试命中缓存，直接返回
      try {
        const cache = await getCachePath(graphSignature2)
        const cachedPath = cache?.path
        const cachedStart = cache?.start_id
        const cachedMin = cache?.min_steps
        if (cachedPath && cachedPath.length>0 && cachedStart!=null) {
          const SNAPSHOT_LIMIT = 40
          const snapshots = await captureCanvasPNG(canvasRef.current, triangles, cachedStart, cachedPath.slice(0, SNAPSHOT_LIMIT))
          setSteps([{ path: cachedPath, images: snapshots }])
          setBestStartId(cachedStart)
          setStatus(`缓存命中：最短步骤 ${cachedMin??cachedPath.length}（起点 #${cachedStart}）`)
          setSolveProgress(null)
          try { if(__runId2) await telemetryFinishRun(__runId2, { status:'cache_hit', min_steps: cachedMin??cachedPath.length, best_start_id: cachedStart, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature2 }) } catch {}
          try { await uploadStrategyAuto(triangles, palette, 'continue_shortest', cachedStart, cachedPath) } catch {}
          return
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
                const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phaseRaw3}${compInfo3}${extra3} nodes=${p?.nodes??0} queue=${p?.queue??0} sols=${p?.solutions??0} enq=${perf?.enqueued??'-'} exp=${perf?.expanded??'-'} zf=${perf?.filteredZero??'-'}`
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
        // 覆写 flags：在有限步数时加强最短路搜索（关闭 DFS-first/早停，启用强下界）
        const flags = Number.isFinite(maxStepsLimit)
          ? { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false, useStrongLBInBestFirst: true, enableBeam: true, beamWidth: Math.max(24, window.SOLVER_FLAGS?.beamWidth ?? 32), beamMin: Math.max(10, window.SOLVER_FLAGS?.beamMin ?? 8), bifrontWeight: Math.max(2.2, window.SOLVER_FLAGS?.bifrontWeight ?? 2.0), lbImproveMin: Math.max(2, window.SOLVER_FLAGS?.lbImproveMin ?? 1) }
          : { ...(window.SOLVER_FLAGS||{}), useDFSFirst: false, returnFirstFeasible: false }
        try { worker.postMessage({ type:'set_flags', flags }) } catch {}
        const lightTris3 = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
        worker.postMessage({ type:'auto', triangles: lightTris3, palette, maxBranches, stepLimit: maxStepsLimit })
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
      try { await putCachePath(graphSignature2, { path: unifiedPaths[0]||[], min_steps: result.minSteps, start_id: result.bestStartId, flags: window.SOLVER_FLAGS }) } catch {}
      try { await uploadStrategyAuto(triangles, palette, 'continue_shortest', result.bestStartId, unifiedPaths[0]||[]) } catch {}
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
    try {
      if (!steps || steps.length === 0) { setStatus('暂无可行方案，先执行自动求解'); return }
      const originalPath = steps[0]?.path
      const sid = bestStartId ?? pickHeuristicStartId(triangles)
      setSolving(true)
      setStatus('正在进行路径优化（反思 / 拆解 / 压缩）…')
      setSolveProgress({ phase: 'optimize_init' })
      setProgressLogs([])
      solveStartRef.current = Date.now()
      // 启动遥测 Run（不阻塞）
      const graphSignature3 = makeGraphSignature(triangles, palette)
      let __runId3 = null
      try { const __r3 = await telemetryStartRun(triangles, palette, { ...(window.SOLVER_FLAGS||{}), mode: 'optimize_path' }); __runId3 = __r3?.runId || null } catch {}
      const telemetrySafeLog3 = async (payload)=>{ try{ if(__runId3) await telemetryLogEvent(__runId3, payload) }catch{} }
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
                telemetrySafeLog3({ phase, perf, extra: { criticalCount: p?.criticalCount, minSteps: p?.minSteps, components: p?.count } })
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
        const lightTris5 = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
        worker.postMessage({ type:'optimize', triangles: lightTris5, palette, startId: sid, path: originalPath })
        result = await resPromise
      } catch (err) {
        try{ window.__solverWorker = null }catch{}
        // 回退：主线程路径优化
        const lightTris6 = triangles.map(t=>({ id: t.id, neighbors: t.neighbors, color: t.color, deleted: !!t.deleted }))
        result = await window.OptimizeSolution?.(lightTris6, palette, sid, originalPath, (p)=>{
          const now = Date.now()
          const phase = p?.phase || 'optimize'
          if (now - progressLastRef.current > 200) {
            setStatus(`正在路径优化… 阶段：${phase}`)
            setSolveProgress({ phase, criticalCount: p?.criticalCount, minSteps: p?.minSteps })
            const line = `[${((now - solveStartRef.current)/1000).toFixed(1)}s] phase=${phase} crit=${p?.criticalCount??'-'} min=${p?.minSteps??'-'}`
            setProgressLogs(prev=>{ const next=[...prev,line]; return next.length>200 ? next.slice(next.length-200) : next })
            progressLastRef.current = now
            telemetrySafeLog3({ phase, extra: { criticalCount: p?.criticalCount, minSteps: p?.minSteps } })
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
        try { await putCachePath(graphSignature3, { path: result.optimizedPath, min_steps: result.optimizedLen, start_id: result.bestStartId ?? sid, flags: window.SOLVER_FLAGS }) } catch {}
        try { if(__runId3) await telemetryFinishRun(__runId3, { status:'finished', min_steps: result.optimizedLen, best_start_id: result.bestStartId ?? sid, time_ms: Date.now() - solveStartRef.current, graph_signature: graphSignature3 }) } catch {}
        try { await uploadStrategyAuto(triangles, palette, 'optimize_path', (result.bestStartId ?? sid), result.optimizedPath, (result?.analysis?.critical||null)) } catch {}
      } else {
        setStatus('未发现更短且统一的路径（已完成关键节点分析，可查看日志）')
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

  // 总站子页渲染：集中存储与聚合展示
  if (route === '#/hub') {
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
      const onCancel = () => {
        try { window.location.hash = '#/help' } catch { window.location.hash = '#/help' }
      }
      const onKeyDown = (e) => { if (e.key === 'Enter') onSubmit() }
      return (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
          <div className="panel" style={{ width:'360px', background:'var(--panel)', padding:'16px', boxShadow:'0 6px 24px rgba(0,0,0,.2)' }}>
            <h3 style={{ margin:'0 0 12px 0', fontSize:'15px', color:'var(--muted)' }}>请输入密码</h3>
            <input
              type="password"
              value={hubPwd}
              onChange={e=>setHubPwd(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="密码"
              style={{ width:'100%', padding:'8px', border:'1px solid var(--panel-border)', borderRadius:4, marginBottom:'12px', background:'var(--bg)' }}
            />
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
        <CentralHub />
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
            <label>分辨率</label>
            <span style={{ display:'inline-flex', gap:'.35rem' }}>
              <button onClick={()=>setResolutionScale(1)} disabled={loadedProject || resolutionScale===1} title={loadedProject ? '导入工程状态下分辨率不可改' : '将网格分辨率设为 1x'}>1x</button>
              <button onClick={()=>setResolutionScale(2)} disabled={loadedProject || resolutionScale===2} title={loadedProject ? '导入工程状态下分辨率不可改' : '将网格分辨率设为 2x（约四倍三角数量）'}>2x</button>
              <button onClick={()=>setResolutionScale(4)} disabled={loadedProject || resolutionScale===4} title={loadedProject ? '导入工程状态下分辨率不可改' : '将网格分辨率设为 4x（更细）'}>4x</button>
            </span>
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
