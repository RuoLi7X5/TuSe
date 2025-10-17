import { useEffect, useMemo, useRef, useState } from 'react'
import { listPDBKeys, hasPDB, loadPDBObject, loadPDBFromJSON, loadPDBFromURL, getPDBBaseURL, listRemotePDBKeys } from '../utils/pdb'
import { listHeuristicNames } from '../utils/heuristics'

// 性能调节面板：集中管理求解器的所有可调参数
export default function PerformanceTuner({ onClose }) {
  const existing = typeof window !== 'undefined' ? (window.SOLVER_FLAGS || {}) : {}
  // 默认值（与 solver.js / solver-worker.js 保持一致）
  const defaults = useMemo(() => ({
    // 基本搜索策略（与默认初始设置一致）
    enableLB: true,
    enableLookahead: true,
    enableLookaheadDepth2: false,
    enableIncremental: true,
    enableBeam: false,
    beamWidth: 32,
    // 动态束宽参数
    beamDecay: 0.85,
    beamMin: 4,
    enableBestFirst: true,
    // Best-First 行为细化
    useAStarInBestFirst: true,
    useStrongLBInBestFirst: false,
    enableBridgeFirst: true,
    enableZeroExpandFilter: true,
    useDFSFirst: false,
    returnFirstFeasible: false,
    // 严格模式（A* 最短路）
    strictMode: false,
    useIDAStar: false,
    enableTTMinFReuse: true,
    // 学习驱动优先级（UCB Bandit）与 SAT 宏规划
    enableLearningPrioritizer: true,
    enableSATPlanner: false,
    // 严格下界增强启发式（插件）：none / pdb6x6_max 等
    heuristicName: 'none',
    logPerf: true,
    // 进度与时间预算
    workerTimeBudgetMs: 300000,
    // 并行 worker 数量（自动并行最短路）
    parallelWorkers: 3,
    // 预处理（components）阶段时间预算
    preprocessTimeBudgetMs: 20000,
    progressComponentsIntervalMs: 0,
    // DFS 阶段进度节流
    progressDFSIntervalMs: 100,
    // A* 阶段进度节流
    progressAStarIntervalMs: 80,
    // 权重参数
    adjAfterWeight: 0.6,
    bridgeWeight: 1.0,
    gateWeight: 0.4,
    richnessWeight: 0.5,
    boundaryWeight: 0.8,
    regionClassWeights: { boundary: 0.8, bridge: 1.0, richness: 0.6 },
    dimensionWeights: { expand: 1.0, connect: 0.8, barrier: 0.7 },
    bifrontWeight: 2.0,
    // 稀有颜色 / 扩张过滤
    rareFreqRatio: 0.03,
    rareFreqAbs: 3,
    rareAllowBridgeMin: 2.0,
    rareAllowGateMin: 1.0,
    minDeltaRatio: 0.02,
    lbImproveMin: 1,
    // 预处理分析与顺序
    preprocessEnableAnalysisOrder: false,
    dispersionThreshold: 0.2,
    bridgeEdgeDensityThreshold: 0.4,
    // 分块与宏规划（试验性）
    enableRAGMacro: false,
    // 质量上报采样
    qualitySampleRate: 0.15,
    gainDropWarnRatio: 0.01,
    // 路径优化
    optimizeWindowSize: 5,
    optimizeEnableWindow: true,
    optimizeEnableRemoval: true,
    optimizeSwapPasses: 1,
    // 通过开关控制是否在启动/切换时自动加载默认 PDB（pdb_6x6）
    enablePDBAutoLoad: true,
    // PDB 基础 URL（远程优先自动加载使用），默认 '/pdb/'
    pdbBaseUrl: '/pdb/',
    // 后端与遥测（发布相关）：保持与 App.jsx 默认一致（生产同域 / 开发 localhost:3001）
    enableTelemetry: true,
    serverBaseUrl: '',
  }), [])

  // 初始化：若本地已保存，则合并；否则使用现有 window.SOLVER_FLAGS 与默认值
  const [flags, setFlags] = useState(() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem('solverFlags') || 'null') : null
      const base = saved || existing || {}
      return {
        ...defaults,
        ...base,
        regionClassWeights: { ...defaults.regionClassWeights, ...(base.regionClassWeights || {}) },
        dimensionWeights: { ...defaults.dimensionWeights, ...(base.dimensionWeights || {}) },
        // 遥测默认开启（不在性能调节面板展示，不允许被本地关闭）
        enableTelemetry: true,
      }
    } catch {
      return defaults
    }
  })

  useEffect(() => {
    // 打开时同步 window.SOLVER_FLAGS（不覆盖已有）
    try { window.SOLVER_FLAGS = { ...(window.SOLVER_FLAGS || {}), ...flags } } catch {}
  }, [])

  const setFlag = (key, value) => setFlags(prev => ({ ...prev, [key]: value }))
  const setNested = (key, sub, value) => setFlags(prev => ({ ...prev, [key]: { ...(prev[key] || {}), [sub]: value } }))

  // 改进：参数变动即刻同步到 window 与当前 worker，并持久化到 localStorage
  useEffect(() => {
    try { window.SOLVER_FLAGS = { ...(window.SOLVER_FLAGS || {}), ...flags } } catch {}
    try { window.__solverWorker?.postMessage({ type: 'set_flags', flags }) } catch {}
    try { localStorage?.setItem('solverFlags', JSON.stringify(flags)) } catch {}
  }, [flags])

  // 计算后端基础地址（用于健康检查）；同域优先，回退到开发默认
  const getServerBase = () => {
    if (flags.serverBaseUrl && String(flags.serverBaseUrl).trim()) return String(flags.serverBaseUrl).trim()
    if (typeof window !== 'undefined' && window.location && window.location.origin && !/localhost/i.test(window.location.hostname)) {
      return window.location.origin
    }
    return 'http://localhost:3001'
  }

  // 后端健康检查状态
  const [healthOk, setHealthOk] = useState(null)
  const [healthMsg, setHealthMsg] = useState('')
  const onCheckHealth = async () => {
    const base = getServerBase()
    try {
      setHealthMsg('正在检查…')
      const res = await fetch(`${base}/api/health`, { method:'GET' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json().catch(()=>({}))
      setHealthOk(true)
      setHealthMsg(`后端健康：${data?.status||'ok'}（${base}）`)
    } catch (e) {
      setHealthOk(false)
      setHealthMsg(`连接失败：${String(e.message||e)}（${base}）`)
    }
  }

  const onSave = () => {
    try {
      const next = { ...flags }
      window.SOLVER_FLAGS = next
      localStorage?.setItem('solverFlags', JSON.stringify(next))
      try { window.__solverWorker?.postMessage({ type: 'set_flags', flags: next }) } catch {}
      alert('参数已保存并同步到工作线程。')
    } catch {}
    onClose?.()
  }

  const Section = ({ title, children }) => (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ fontWeight: 600, color: '#cbd3e1', marginBottom: '.5rem' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.5rem' }}>{children}</div>
    </div>
  )

  const Field = ({ label, tooltip, children }) => {
    const [hover, setHover] = useState(false)
    return (
      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: '12px', color: '#a9b3c9', marginBottom: '4px', display:'inline-block', cursor:'help' }} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}>{label}</div>
        {children}
        {hover && tooltip && (
          <div style={{ position:'absolute', zIndex:10, top:'100%', left:0, marginTop:'4px', background:'#0f1420', color:'#cbd3e1', border:'1px solid var(--border)', borderRadius:'6px', padding:'8px', fontSize:'12px', maxWidth:'420px', boxShadow:'0 4px 10px rgba(0,0,0,0.35)' }}>
            {tooltip}
          </div>
        )}
      </div>
    )
  }

  const SelectInput = ({ value, onChange, options }) => (
    <select value={value ?? ''} onChange={e=>onChange(e.target.value)}
      style={{ width:'100%', padding:'6px', borderRadius:'6px', border:'1px solid var(--border)', background:'#1a1f2b', color:'var(--text)' }}>
      {(options||[]).map(opt=>{
        const v = typeof opt === 'string' ? opt : opt.value
        const label = typeof opt === 'string' ? opt : (opt.label ?? opt.value)
        return <option key={v} value={v}>{label}</option>
      })}
    </select>
  )

  const BoolInput = ({ value, onChange }) => (
    <label style={{ display:'inline-flex', alignItems:'center', gap:'.5rem', cursor:'pointer' }}>
      <input type="checkbox" checked={!!value} onChange={e=>onChange(e.target.checked)} />
      <span style={{ color:'#cbd3e1' }}>{value? '开启' : '关闭'}</span>
    </label>
  )
  const NumInput = ({ value, onChange, step=1, min, max }) => {
    const [draft, setDraft] = useState(() => String(value ?? ''))
    useEffect(() => { setDraft(String(value ?? '')) }, [value])
    const commit = () => {
      const n = parseFloat(draft)
      if (Number.isFinite(n)) onChange(n)
      else setDraft(String(value ?? ''))
    }
    const onKeyDown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit() }
    }
    return (
      <input type="number" value={draft} step={step} min={min} max={max}
        onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={onKeyDown}
        style={{ width:'100%', padding:'6px', borderRadius:'6px', border:'1px solid var(--border)', background:'#1a1f2b', color:'var(--text)' }} />
    )
  }

  const StatusBadge = ({ ok, text }) => (
    <span style={{ display:'inline-block', borderRadius:'999px', padding:'2px 8px', background: ok ? '#1e3a28' : '#3a1e28', color: ok ? '#a6e3a1' : '#f2c0c0', fontSize:'12px', border:'1px solid var(--border)' }}>{text}</span>
  )

  const TextInput = ({ value, onChange, placeholder }) => (
    <input type="text" value={value ?? ''} placeholder={placeholder}
      onChange={e=>onChange(e.target.value)}
      style={{ width:'100%', padding:'6px', borderRadius:'6px', border:'1px solid var(--border)', background:'#1a1f2b', color:'var(--text)' }} />
  )

  // 恢复默认配置：将所有参数重置为默认值（即新用户初始配置）
  const onResetDefaults = () => {
    try {
      const next = {
        ...defaults,
        // 深拷贝嵌套对象以确保状态变更
        regionClassWeights: { ...defaults.regionClassWeights },
        dimensionWeights: { ...defaults.dimensionWeights },
      }
      setFlags(next)
      // 额外的即时同步（useEffect 也会同步），防止用户期望立即生效
      if (typeof window !== 'undefined') {
        window.SOLVER_FLAGS = next
        try { localStorage.setItem('solverFlags', JSON.stringify(next)) } catch {}
        try { window.__solverWorker?.postMessage({ type:'set_flags', flags: next }) } catch {}
      }
      try { alert('已恢复默认配置。') } catch {}
    } catch (e) {
      console.warn('恢复默认配置失败：', e)
    }
  }

  const contentRef = useRef(null)
  const scrollPosRef = useRef(0)

  // 动态检测已加载的 PDB 键
  const [pdbKeys, setPdbKeys] = useState(() => {
    try { return listPDBKeys() } catch { return [] }
  })
  useEffect(() => { try { setPdbKeys(listPDBKeys()) } catch {} }, [])

  // 启发式选项列表：来自注册表与动态 PDB（包含分层变体）
  const heurOptions = useMemo(() => {
    const names = (()=>{ try { return listHeuristicNames() } catch { return ['none'] } })()
    const opts = []
    for(const name of names){
      if(name === 'none') { opts.push({ value:'none', label:'none（关闭）' }); continue }
      const isLayered = /^layered_/.test(name)
      let label = name
      if(isLayered){
        // 标注分层启发式的注意事项
        if(/_max$/.test(name)) label = `${name}（分层，可采纳）`
        else label = `${name}（分层，非可采纳，慎用于严格 A*/IDA*）`
      } else if(name === 'pdb6x6_max') {
        const loaded = (()=>{ try { return hasPDB('pdb_6x6') } catch { return false } })()
        label = loaded ? 'pdb6x6_max（已加载）' : 'pdb6x6_max（未加载）'
      } else {
        const m = /^pdb_([A-Za-z0-9_]+)_max$/.exec(name)
        if(m){
          const key = `pdb_${m[1]}`
          const loaded = (()=>{ try { return hasPDB(key) } catch { return false } })()
          label = `${name}（${loaded?'已加载':'未加载'}）`
        }
      }
      opts.push({ value: name, label })
    }
    return opts
  }, [pdbKeys])

  const describeHeuristic = (name) => {
    if(!name || name==='none') return '关闭启发式插件，仅使用严格下界（可采纳）。适用：追求稳定与最优性证明时。'
    if(name==='pdb6x6_max'){
      const loaded = (()=>{ try { return hasPDB('pdb_6x6') } catch { return false } })()
      return loaded
        ? '试验性 PDB（6x6）：基于局部边界颜色生成签名并查表估计下界，与严格下界取 max 保证可采纳。'
        : '试验性 PDB（6x6）：当前未加载 PDB，估计将返回 0，等效于仅用严格下界。'
    }
    if(/^layered_pdb_([A-Za-z0-9_]+)_max$/.test(name)){
      const suf = name.replace(/^layered_pdb_/,'').replace(/_max$/,'')
      const key = `pdb_${suf}`
      const loaded = (()=>{ try { return hasPDB(key) } catch { return false } })()
      return loaded
        ? `分层启发式（${key}）：与严格下界取 max 保持可采纳性，适用于严格 A*/IDA* 的最优性证明。`
        : `分层启发式（${key}）：当前未加载该 PDB，分层估计将退化为仅用严格下界。`
    }
    if(/^layered_pdb_([A-Za-z0-9_]+)_sum_[0-9]+(?:\.[0-9]+)?$/.test(name)){
      return '分层启发式（sum）：lbStrict + w * pdb。说明：非可采纳（除 w=0），若用于严格 A*/IDA* 将不再可证最优。用于非严格阶段的排序与加速。'
    }
    if(/^layered_pdb_([A-Za-z0-9_]+)_weighted_[0-9]+(?:\.[0-9]+)?_[0-9]+(?:\.[0-9]+)?$/.test(name)){
      return '分层启发式（weighted）：ws * lbStrict + wp * pdb。说明：一般非可采纳（除 ws≤1 且 wp=0），慎用于严格 A*/IDA*。用于非严格阶段排序与加速。'
    }
    const m = /^pdb_([A-Za-z0-9_]+)_max$/.exec(name)
    if(m){
      const key = `pdb_${m[1]}`
      const loaded = (()=>{ try { return hasPDB(key) } catch { return false } })()
      return loaded
        ? `PDB（${key}）：使用预加载的模式库对局部边界进行估计，并与严格下界取 max 保证可采纳。适用：该规模的子图下界较有效。`
        : `PDB（${key}）：当前未加载该 PDB，估计将返回 0，等效于仅用严格下界。`
    }
    return '启发式：未识别的选项或未注册，默认不生效。'
  }
  useEffect(() => {
    // 在 flags 更新时恢复滚动位置，避免内容变化把容器滚动到顶部
    if (contentRef.current) {
      contentRef.current.scrollTop = scrollPosRef.current || contentRef.current.scrollTop
    }
  }, [flags])

  // 在 PDB 列表变化时也恢复滚动位置，避免刷新导致回到顶部
  useEffect(() => {
    try {
      if (contentRef.current) {
        contentRef.current.scrollTop = scrollPosRef.current || contentRef.current.scrollTop
      }
    } catch {}
  }, [pdbKeys])

  // RAG 宏规划切换时输出明显日志
  useEffect(() => {
    try {
      if(flags.enableRAGMacro){
        console.info('[RAG] 宏规划已启用：将输出分块与宏顺序日志。')
      } else {
        console.info('[RAG] 宏规划已关闭。')
      }
    } catch{}
  }, [flags.enableRAGMacro])

  // 启发式切换时输出说明日志
  useEffect(() => {
    try {
      const desc = describeHeuristic(flags.heuristicName)
      console.info(`[Heuristic] 选择：${flags.heuristicName}；${desc}`)
    } catch{}
  }, [flags.heuristicName])

  // 按需自动加载默认 PDB（pdb_6x6），仅在开关开启时尝试且未加载时触发
  useEffect(() => {
    if (!flags.enablePDBAutoLoad) return
    (async () => {
      try {
        const key = 'pdb_6x6'
        if (!hasPDB(key)) {
          const prevPos = contentRef.current?.scrollTop || 0
          let loaded = false
          // 远程优先：尝试从基础 URL 拉取 JSON
          try {
            const base = flags.pdbBaseUrl || getPDBBaseURL()
            const url = `${base.endsWith('/') ? base : base + '/'}${key}.json`
            loaded = await loadPDBFromURL(key, url)
            if (loaded) console.info(`[PDB] 自动加载完成（远程）：${key} <- ${url}`)
          } catch {}
          // 本地回退：window 注入对象或 localStorage
          if (!loaded) {
            const sourceObj = (typeof window !== 'undefined' && window.__PDB_AUTOLOAD__ && window.__PDB_AUTOLOAD__[key]) ? window.__PDB_AUTOLOAD__[key] : null
            const lsJson = typeof localStorage !== 'undefined' ? localStorage.getItem('PDB:' + key) : null
            if (sourceObj && typeof sourceObj === 'object') {
              loaded = !!loadPDBObject(key, sourceObj)
            } else if (lsJson) {
              loaded = !!loadPDBFromJSON(key, lsJson)
            }
            console.info(loaded ? `[PDB] 自动加载完成（本地来源）：${key}` : `[PDB] 未找到默认 PDB 数据：${key}`)
          }
          if (loaded) {
            try { setPdbKeys(listPDBKeys()) } catch {}
            // 恢复滚动位置，避免内容变化跳回顶部
            setTimeout(() => { try { if (contentRef.current) contentRef.current.scrollTop = prevPos } catch {} }, 0)
          }
        }
      } catch (e) {
        console.warn('[PDB] 自动加载异常：', e)
      }
    })()
  }, [flags.enablePDBAutoLoad, flags.pdbBaseUrl])

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div ref={contentRef} onScroll={() => { try { scrollPosRef.current = contentRef.current?.scrollTop || 0 } catch {} }} style={{ width:'860px', maxWidth:'95vw', maxHeight:'85vh', overflow:'auto', background:'#0f1420', border:'1px solid var(--border)', borderRadius:'10px', padding:'16px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'8px' }}>
          <div style={{ fontSize:'16px', fontWeight:700, color:'#cbd3e1' }}>性能调节</div>
          <div style={{ display:'flex', gap:'.5rem' }}>
            <button onClick={onSave}>保存</button>
            <button onClick={onClose}>关闭</button>
          </div>
        </div>

        <Section title="基本搜索策略">
          <Field label="启用下界（启发式剪枝）" tooltip="效果：通过估算当前状态下至少还需多少颜色步骤（下界），提前丢弃不可能更优的分支。\n适用：颜色种类较多、画布较大或分量较散时开启，更能减少无效搜索。\n不适用：非常小的画布或颜色已接近统一时，可关闭以减少计算开销。">
            <BoolInput value={flags.enableLB} onChange={v=>setFlag('enableLB', v)} />
          </Field>
          <Field label="严格 A* 最短路（严格最优保证）" tooltip="效果：启用后分量级别先使用严格 A* 搜索（f=g+h），在给定步数上限与时间预算内穷举最短路径，提供最优性保证。\n建议：中小规模图使用；大图建议配合步数上限（工具栏“步数上限”）与合理时间预算。\n提示：可配合下方“A* 进度节流（ms）”调整 UI 流畅度。">
            <BoolInput value={flags.strictMode} onChange={v=>setFlag('strictMode', v)} />
          </Field>
          <Field label="一步前瞻（Lookahead）" tooltip="效果：模拟下一步着色后的增益，对候选颜色排序，更偏向短期收益大的颜色。\n适用：边界复杂、邻接色很多、候选较多时开启，有助于选到更好的下一步。\n不适用：画布很大且时间紧（前瞻计算开销较高），或已有明确策略（如桥接优先）。">
            <BoolInput value={flags.enableLookahead} onChange={v=>setFlag('enableLookahead', v)} />
          </Field>
          <Field label="两步前瞻（Depth=2）" tooltip="效果：考虑两步后的收益，更保守但计算更重。\n适用：较小画布（<300 三角形）、分量不多或在末端收束阶段希望更稳妥选择。\n不适用：大画布或实时性要求高的场景，建议关闭以节约时间。">
            <BoolInput value={flags.enableLookaheadDepth2} onChange={v=>setFlag('enableLookaheadDepth2', v)} />
          </Field>
          <Field label="增量扩张（优先扩张当前区域）" tooltip="效果：更倾向选择能显著扩大当前连通区域的颜色，减少零扩张尝试。\n适用：起始区域较居中，周边同色块较密集，希望快速变大以接触更多颜色时。\n不适用：需要跨越空隙先“搭桥”连接远端分量的场景（此时桥接优先更合适）。">
            <BoolInput value={flags.enableIncremental} onChange={v=>setFlag('enableIncremental', v)} />
          </Field>
          <Field label="束搜索（Beam Search）" tooltip="效果：每层仅保留评分靠前的有限分支，显著降维搜索空间。\n适用：大画布或颜色多、分支爆炸时开启，可显著提速。\n风险：可能丢弃潜在更优分支，若追求绝对最短路径且规模不大，可关闭。">
            <BoolInput value={flags.enableBeam} onChange={v=>setFlag('enableBeam', v)} />
          </Field>
          <Field label="束宽（Beam Width）" tooltip="效果：控制每层保留的分支数量，越大越保守、越小越激进。\n建议：<300 三角形用 8~16，300~800 用 16~24，>800 用 24~40。\n提示：若发现错过好方案，可适当增大；若速度仍慢，可减小。">
            <NumInput value={flags.beamWidth} onChange={v=>setFlag('beamWidth', v)} min={1} step={1} />
          </Field>
          <Field label="束宽衰减系数（Beam Decay）" tooltip="效果：随搜索深度按系数衰减束宽（0~1），更深层更窄以控复杂度。\n建议：0.80~0.92。越小越激进，越大越保守。">
            <NumInput value={flags.beamDecay} onChange={v=>setFlag('beamDecay', v)} step={0.01} min={0} max={1} />
          </Field>
          <Field label="最小束宽（Beam Min）" tooltip="效果：束宽下限，避免在深层过度收窄导致搜索失真。\n建议：3~8。规模较大时适当增大。">
            <NumInput value={flags.beamMin} onChange={v=>setFlag('beamMin', v)} step={1} min={1} />
          </Field>
          <Field label="最佳优先（Best-First）" tooltip="效果：总是先扩张评分更高的节点，通常能更快逼近解。\n适用：大多数场景下建议开启。\n不适用：希望严格层次遍历（BFS）验证每层完整性时可关闭。">
            <BoolInput value={flags.enableBestFirst} onChange={v=>setFlag('enableBestFirst', v)} />
          </Field>
          <Field label="Best-First 使用 A* 排序" tooltip="效果：在最佳优先中按 f=g+h 的 A* 评分排序，综合考虑当前步数与下界估计。\n建议：一般开启；若希望更自由的启发式排序可关闭。">
            <BoolInput value={flags.useAStarInBestFirst} onChange={v=>setFlag('useAStarInBestFirst', v)} />
          </Field>
          <Field label="Best-First 使用强下界" tooltip="效果：在最佳优先中启用更保守的强下界（严格或近似），减少不可能更优的分支。\n建议：大图或颜色复杂时开启；小图或需更灵活探索时关闭。">
            <BoolInput value={flags.useStrongLBInBestFirst} onChange={v=>setFlag('useStrongLBInBestFirst', v)} />
          </Field>
          <Field label="桥接优先（Bridge-First）" tooltip="效果：偏好能直接连接不同连通分量的颜色，快速减少整体分量数。\n适用：画面被多块颜色分隔、存在明显断裂或窄通道时开启。\n不适用：单一大分量内收束时，关闭以避免过度偏好桥接。">
            <BoolInput value={flags.enableBridgeFirst} onChange={v=>setFlag('enableBridgeFirst', v)} />
          </Field>
          <Field label="零扩张过滤" tooltip="效果：剔除对当前区域扩张比例极小的颜色，减少无效动作。\n适用：希望加速、避免“几乎不变”的微小步骤时开启。\n不适用：在精细拼接阶段需要小步微调（结合较低的最小扩张比例阈值）。">
            <BoolInput value={flags.enableZeroExpandFilter} onChange={v=>setFlag('enableZeroExpandFilter', v)} />
          </Field>
          <Field label="先用 DFS 找任意可行解" tooltip="效果：深度优先快速找到一个可行方案，便于后续优化。\n适用：路径优化阶段或临时需要一个解时开启。\n不适用：正式最短路径搜索阶段，关闭以保证最优性。">
            <BoolInput value={flags.useDFSFirst} onChange={v=>setFlag('useDFSFirst', v)} />
          </Field>
          <Field label="找到可行解立即返回" tooltip="效果：一旦得到任何可行解就停止继续搜索，节省时间。\n适用：配合 DFS-first 在优化阶段使用。\n不适用：需要更优或最短方案的阶段。">
            <BoolInput value={flags.returnFirstFeasible} onChange={v=>setFlag('returnFirstFeasible', v)} />
          </Field>
          <Field label="性能日志" tooltip="效果：输出入队/扩张/过滤等统计，便于观察瓶颈与调参效果。\n适用：调参与问题定位阶段。\n不适用：正式演示或追求清爽界面时关闭。">
            <BoolInput value={flags.logPerf} onChange={v=>setFlag('logPerf', v)} />
          </Field>
        </Section>

        <Section title="严格模式设置">
          <Field label="使用 IDA*（迭代加深 A*）" tooltip="效果：严格模式下使用 IDA* 搜索，逐步提高 f 上限，通常在步数上限较小或图较复杂时更稳。\n关闭则使用标准 A*。">
            <BoolInput value={flags.useIDAStar} onChange={v=>setFlag('useIDAStar', v)} />
          </Field>
          <Field label="启用 TT 最小 f 复用" tooltip="效果：在严格求解器中复用跨迭代的 Transposition Table 最小 f 值，减少重复搜索。\n建议：一般开启；调试 TT 行为时可关闭对比。">
            <BoolInput value={flags.enableTTMinFReuse} onChange={v=>setFlag('enableTTMinFReuse', v)} />
          </Field>
          <Field label="启用默认加载 PDB（pdb_6x6）" tooltip={"效果：仅通过一个开关控制是否在启动/切换时自动加载默认 PDB。\n来源优先级：远程（基础 URL）> window.__PDB_AUTOLOAD__.pdb_6x6 > localStorage('PDB:pdb_6x6')。\n用途：启用后，启发式选项中的 pdb6x6_max 会在加载就绪后生效。"}>
            <BoolInput value={flags.enablePDBAutoLoad} onChange={v=>setFlag('enablePDBAutoLoad', v)} />
          </Field>
          <Field label="PDB 基础 URL" tooltip={"来源目录或 CDN 路径，默认 '/pdb/'。\n示例：/pdb/ 或 https://cdn.example.com/pdb/；需要包含 index.json 与 <key>.json（如 pdb_6x6.json）。"}>
            <TextInput value={flags.pdbBaseUrl} onChange={v=>setFlag('pdbBaseUrl', v)} placeholder="/pdb/" />
          </Field>
          <Field label="严格下界增强启发式（含分层）" tooltip={"说明：\n- layered_pdb_*_max 与严格下界取 max，保持可采纳性（最优性可证）。\n- layered_pdb_*_sum / _weighted 为非可采纳（除特殊权重），若用于严格 A*/IDA* 将不再可证最优。\n建议：追求最优时使用 layered_pdb_*_max 或保持默认 max(lbStrict, heuristic)。\n提示：PDB 选项在加载对应 PDB 后生效，否则退化为 0。"}>
            <SelectInput value={flags.heuristicName} onChange={v=>setFlag('heuristicName', v)} options={heurOptions} />
            <div style={{ marginTop:'4px', fontSize:'12px', color:'#93a0b7' }}>{describeHeuristic(flags.heuristicName)}</div>
          </Field>
          {/* 刷新 PDB 列表按钮与当前检测状态 */}
          <div style={{ gridColumn:'1 / -1', display:'flex', alignItems:'center', gap:'.5rem' }}>
            <button onClick={() => {
              try {
                const prevPos = contentRef.current?.scrollTop || 0
                const keys = listPDBKeys()
                setPdbKeys(keys)
                // 下一渲染周期恢复滚动位置，避免刷新导致跳回顶部
                setTimeout(() => { try { if (contentRef.current) contentRef.current.scrollTop = prevPos } catch {} }, 0)
                console.info(`[PDB] 列表已刷新：本地已加载 ${keys.length} 个`)
                // 可选：尝试拉取远程索引，便于提示可用键
                try {
                  const base = flags.pdbBaseUrl || getPDBBaseURL()
                  const idxUrl = `${base.endsWith('/') ? base : base + '/'}index.json`
                  listRemotePDBKeys(idxUrl).then(remote => {
                    if (Array.isArray(remote)) {
                      console.info(`[PDB] 远程索引：可用 ${remote.length} 个`, remote)
                    }
                  }).catch(()=>{})
                } catch {}
              } catch {}
            }} title="刷新已加载的 PDB 列表，无需关闭面板">刷新 PDB 列表</button>
            <StatusBadge ok={pdbKeys.length>0} text={pdbKeys.length>0 ? `PDB：已检测到 ${pdbKeys.length} 个` : 'PDB：未检测到'} />
          </div>
        </Section>

        <Section title="启发式与加速开关">
          <Field label="启用学习优先器（UCB Bandit）" tooltip={"效果：在颜色排序中结合历史增益学习（UCB），更偏向长期收益更好的颜色。\n用途：仅用于排序，不影响严格下界与最优性判定。\n建议：开启，配合非严格阶段显著提速。"}>
            <BoolInput value={flags.enableLearningPrioritizer} onChange={v=>setFlag('enableLearningPrioritizer', v)} />
          </Field>
          <Field label="启用 SAT 宏规划（集合覆盖）" tooltip={"效果：在正式搜索前尝试通过集合覆盖模型生成宏观颜色序列作为前置加速。\n说明：若生成序列不理想，后续严格搜索/MCTS 与后优化仍会兜底。"}>
            <BoolInput value={flags.enableSATPlanner} onChange={v=>setFlag('enableSATPlanner', v)} />
          </Field>
          <div style={{ gridColumn:'1 / -1', display:'flex', alignItems:'center', gap:'.5rem' }}>
            <StatusBadge ok={!!flags.enableLearningPrioritizer} text={flags.enableLearningPrioritizer ? 'UCB：开启' : 'UCB：关闭'} />
            <StatusBadge ok={!!flags.enableSATPlanner} text={flags.enableSATPlanner ? 'SAT 宏规划：开启' : 'SAT 宏规划：关闭'} />
          </div>
        </Section>

        <Section title="预处理分析与顺序">
          <Field label="启用分析驱动的分量顺序" tooltip="效果：根据颜色离散度与桥接潜力，重排分量处理顺序（优先高离散度且有桥接潜力的分量）。\n适用：希望更快进入对全局最有价值分量的搜索。">
            <BoolInput value={flags.preprocessEnableAnalysisOrder} onChange={v=>setFlag('preprocessEnableAnalysisOrder', v)} />
          </Field>
          <Field label="离散度阈值" tooltip="效果：当颜色的离散度高于该值时，判作高离散度（优先处理）。\n建议：0.15~0.30，图案越碎越可适当调高。">
            <NumInput value={flags.dispersionThreshold} onChange={v=>setFlag('dispersionThreshold', v)} step={0.01} />
          </Field>
          <Field label="桥接边密度阈值" tooltip="效果：当分量的跨边界边比例高于该值时，判作桥接分量（优先处理）。\n建议：0.3~0.6，图案分裂较多时适当提高。">
            <NumInput value={flags.bridgeEdgeDensityThreshold} onChange={v=>setFlag('bridgeEdgeDensityThreshold', v)} step={0.01} />
          </Field>
        </Section>

        {/** 后端遥测相关设置已移除：默认开启且不在面板中展示 **/}

        <Section title="质量上报采样">
          <Field label="质量采样比例" tooltip="效果：在入队新分支时采样上报质量（delta、下界、优先级等），便于观察选择倾向与瓶颈。\n建议：0.05~0.20，过高会导致日志很多。">
            <NumInput value={flags.qualitySampleRate} onChange={v=>setFlag('qualitySampleRate', v)} step={0.01} />
          </Field>
          <Field label="增益下降告警阈值" tooltip="效果：当扩张增益比率低于该值时标注为“增益下降”，便于识别低收益步骤。\n建议：0.005~0.02。">
            <NumInput value={flags.gainDropWarnRatio} onChange={v=>setFlag('gainDropWarnRatio', v)} step={0.001} />
          </Field>
        </Section>

        <Section title="进度与时间预算">
          <Field label="工作线程时间预算（ms）" tooltip="效果：限制每轮自动求解在工作线程可用的总时间，超出后切换/早停。
建议：小图 20,000~40,000；中图 40,000~80,000；大图 80,000~180,000。
提示：值越小越早看到阶段切换和搜索节点进度。">
            <NumInput value={flags.workerTimeBudgetMs} onChange={v=>setFlag('workerTimeBudgetMs', v)} step={1000} min={1000} />
          </Field>
          <Field label="并行 worker 数量" tooltip="效果：自动并行最短路时并发 worker 数量（每个起点一个）。\n建议：2~4；机器性能高或图较大可适当增大。">
            <NumInput value={flags.parallelWorkers} onChange={v=>setFlag('parallelWorkers', v)} step={1} min={1} />
          </Field>
          <Field label="预处理阶段时间预算（ms）" tooltip="效果：控制连通分量识别（components 阶段）的最长耗时，超过该时间会提前结束预处理并进入搜索。
默认：300,000（5 分钟）。可根据图大小与性能调节。">
            <NumInput value={flags.preprocessTimeBudgetMs} onChange={v=>setFlag('preprocessTimeBudgetMs', v)} step={1000} min={0} />
          </Field>
          <Field label="组件阶段进度节流（ms）" tooltip="效果：控制“components”阶段进度打点的最小间隔（毫秒）。
建议：100~200。若希望几乎每个组件都打印，可设为 0。">
            <NumInput value={flags.progressComponentsIntervalMs} onChange={v=>setFlag('progressComponentsIntervalMs', v)} step={50} min={0} />
          </Field>
          <Field label="DFS 阶段进度节流（ms）" tooltip="效果：控制 DFS 阶段进度打点的最小间隔（毫秒）。
建议：50~200。设为 0 可几乎每步上报（可能导致日志很多）。">
            <NumInput value={flags.progressDFSIntervalMs} onChange={v=>setFlag('progressDFSIntervalMs', v)} step={50} min={0} />
          </Field>
          <Field label="A* 进度节流（ms）" tooltip="效果：控制严格 A* 阶段进度打点的最小间隔（毫秒）。\n建议：60~120。设为 0 可更频繁上报，用于密集调试。">
            <NumInput value={flags.progressAStarIntervalMs} onChange={v=>setFlag('progressAStarIntervalMs', v)} step={20} min={0} />
          </Field>
        </Section>

        <Section title="分块与宏规划（试验）">
          <Field label="启用 RAG 分块/宏规划" tooltip="效果：按 RAG 将画面分块并规划宏观求解顺序（试验性骨架）。\n说明：当前仅输出规划概要，后续将接入严格求解器的块级调度。">
            <BoolInput value={flags.enableRAGMacro} onChange={v=>setFlag('enableRAGMacro', v)} />
          </Field>
          <div style={{ gridColumn:'1 / -1', display:'flex', alignItems:'center', gap:'.5rem' }}>
            <StatusBadge ok={!!flags.enableRAGMacro} text={flags.enableRAGMacro ? 'RAG 宏规划：已启用（将输出块划分与宏顺序日志）' : 'RAG 宏规划：已关闭'} />
          </div>
        </Section>

        <Section title="评分权重">
          <Field label="邻接后权重（Adj-After）" tooltip="效果：鼓励选择能在扩张后带来更多邻接颜色的步骤，增加后续选择空间。\n建议：0.4~0.8。增大：早期探索丰富邻接；减小：后期更关注收束（边界/桥接）。">
            <NumInput value={flags.adjAfterWeight} onChange={v=>setFlag('adjAfterWeight', v)} step={0.1} />
          </Field>
          <Field label="桥接权重（Bridge）" tooltip="效果：提高能连接不同分量颜色的优先级，快速减少分量数。\n建议：分量多或断裂明显时提高；单一大分量内收束时降低。">
            <NumInput value={flags.bridgeWeight} onChange={v=>setFlag('bridgeWeight', v)} step={0.1} />
          </Field>
          <Field label="闸门权重（Gate）" tooltip="效果：偏好能打通狭窄通道的颜色，利于跨越瓶颈。\n建议：迷宫/通道型结构提高；空间开阔时可降低。">
            <NumInput value={flags.gateWeight} onChange={v=>setFlag('gateWeight', v)} step={0.1} />
          </Field>
          <Field label="丰富度权重（Richness）" tooltip="效果：奖励增加不同邻接颜色的步骤，使后续选择更灵活。\n建议：早期略高（0.5~0.8），后期收束时降低以避免引入多余颜色。">
            <NumInput value={flags.richnessWeight} onChange={v=>setFlag('richnessWeight', v)} step={0.1} />
          </Field>
          <Field label="边界权重（Boundary）" tooltip="效果：鼓励减少不同颜色的边界，利于统一。\n建议：中后期提高（0.8~1.2），早期探索阶段适中（0.6~0.8）。">
            <NumInput value={flags.boundaryWeight} onChange={v=>setFlag('boundaryWeight', v)} step={0.1} />
          </Field>
          <Field label="双前沿权重（Bifront）" tooltip="效果：在两个相对前沿接触时偏向于促成合并，减少中间隔离区。\n建议：图案呈条带/对称双侧推进时提高；无明显双前沿时保持默认。">
            <NumInput value={flags.bifrontWeight} onChange={v=>setFlag('bifrontWeight', v)} step={0.1} />
          </Field>
          <Field label="类别权重：边界" tooltip="效果：在路径重排与压缩中提升边界类步骤的相对重要性。\n建议：中后期增大，配合收束。">
            <NumInput value={flags.regionClassWeights.boundary} onChange={v=>setNested('regionClassWeights','boundary', v)} step={0.1} />
          </Field>
          <Field label="类别权重：桥接" tooltip="效果：在路径重排与压缩中提升桥接类步骤的相对重要性。\n建议：分量较多、需要跨越断裂时增大。">
            <NumInput value={flags.regionClassWeights.bridge} onChange={v=>setNested('regionClassWeights','bridge', v)} step={0.1} />
          </Field>
          <Field label="类别权重：丰富度" tooltip="效果：在路径重排与压缩中提升丰富度类步骤的相对重要性。\n建议：早期略高，后期收束下降。">
            <NumInput value={flags.regionClassWeights.richness} onChange={v=>setNested('regionClassWeights','richness', v)} step={0.1} />
          </Field>
          <Field label="维度权重：扩张" tooltip="效果：在多维评分中提高“扩张”维度的影响力。\n建议：起步阶段较高，便于快速接触更多颜色。">
            <NumInput value={flags.dimensionWeights.expand} onChange={v=>setNested('dimensionWeights','expand', v)} step={0.1} />
          </Field>
          <Field label="维度权重：连通" tooltip="效果：在多维评分中提高“连通/桥接”维度的影响力。\n建议：分量较多时提高；单分量收束时降低。">
            <NumInput value={flags.dimensionWeights.connect} onChange={v=>setNested('dimensionWeights','connect', v)} step={0.1} />
          </Field>
          <Field label="维度权重：阻隔" tooltip="效果：在多维评分中提高“减少阻隔/边界”维度的影响力。\n建议：中后期提升，帮助快速统一。">
            <NumInput value={flags.dimensionWeights.barrier} onChange={v=>setNested('dimensionWeights','barrier', v)} step={0.1} />
          </Field>
        </Section>

        <Section title="稀有颜色与扩张过滤">
          <Field label="稀有频率占比阈值" tooltip="效果：全局占比低于该阈值的颜色被视为稀有，默认更谨慎使用。\n建议：0.02~0.05。增大：更谨慎（更少用稀有色）；减小：稀有色更容易被考虑。">
            <NumInput value={flags.rareFreqRatio} onChange={v=>setFlag('rareFreqRatio', v)} step={0.01} min={0} max={1} />
          </Field>
          <Field label="稀有绝对数量阈值" tooltip="效果：全局数量低于该值的颜色视为稀有。与占比阈值共同作用。\n建议：2~5。放大：更谨慎；缩小：更宽松。">
            <NumInput value={flags.rareFreqAbs} onChange={v=>setFlag('rareFreqAbs', v)} step={1} min={0} />
          </Field>
          <Field label="稀有色允许的最小桥接分" tooltip="效果：仅当稀有色的桥接潜力达到该分值时才考虑。\n建议：2.0 起。提高：更严格（更少用稀有色）；降低：更宽松。">
            <NumInput value={flags.rareAllowBridgeMin} onChange={v=>setFlag('rareAllowBridgeMin', v)} step={0.5} />
          </Field>
          <Field label="稀有色允许的最小闸门分" tooltip="效果：仅当稀有色在打通狭窄通道方面达到该分值时才考虑。\n建议：1.0 起。提高：更严格；降低：更宽松。">
            <NumInput value={flags.rareAllowGateMin} onChange={v=>setFlag('rareAllowGateMin', v)} step={0.5} />
          </Field>
          <Field label="最小扩张比例（Delta/Region）" tooltip="效果：若候选颜色使区域扩张比例低于该值，则过滤。\n建议：0.01~0.05。小画布或精细阶段取 0.01~0.02；追求速度取 0.03~0.05。">
            <NumInput value={flags.minDeltaRatio} onChange={v=>setFlag('minDeltaRatio', v)} step={0.01} min={0} max={1} />
          </Field>
          <Field label="下界改进最小值" tooltip="效果：若该步无法至少减少一定的颜色种类数（下界不改善），则过滤。\n建议：1（默认）。更激进可设 2；若希望更自由探索设 0。">
            <NumInput value={flags.lbImproveMin} onChange={v=>setFlag('lbImproveMin', v)} step={1} min={0} />
          </Field>
        </Section>

        <Section title="路径优化">
          <Field label="局部窗口大小" tooltip="效果：在给定窗口内重排步骤，使高价值步骤靠前、低价值靠后，减少无效重复。\n建议：3~7。窗口越大，优化越充分但耗时越多。">
            <NumInput value={flags.optimizeWindowSize} onChange={v=>setFlag('optimizeWindowSize', v)} step={1} min={1} />
          </Field>
          <Field label="启用窗口重排" tooltip="效果：启用后会在窗口内自动重排，通常能缩短路径或提升稳定性。\n建议：一般开启；若需最小化优化时间可暂时关闭。">
            <BoolInput value={flags.optimizeEnableWindow} onChange={v=>setFlag('optimizeEnableWindow', v)} />
          </Field>
          <Field label="启用低优先移除" tooltip="效果：尝试移除收益较低的步骤，保证仍能统一颜色。\n建议：一般开启。若怀疑移除影响可重复性，可关闭进行对比。">
            <BoolInput value={flags.optimizeEnableRemoval} onChange={v=>setFlag('optimizeEnableRemoval', v)} />
          </Field>
          <Field label="交换尝试回合数" tooltip="效果：对相邻步骤进行交换尝试的迭代次数，越大越充分但耗时越多。\n建议：0~3。路径很长（>80 步）时收益有限，保持 0~1。">
            <NumInput value={flags.optimizeSwapPasses} onChange={v=>setFlag('optimizeSwapPasses', v)} step={1} min={0} />
          </Field>
        </Section>

        {/* 基准测试：对比 UCB/分层 PDB 的耗时与步数 */}
        <Section title="基准测试">
          <Benchmark flags={flags} setFlag={setFlag} />
        </Section>

        {/* 底部操作区：恢复默认配置 */}
        <div style={{ borderTop:'1px solid var(--border)', marginTop:'8px', paddingTop:'8px', display:'flex', justifyContent:'flex-end', gap:'.5rem' }}>
          <button onClick={onResetDefaults} title="恢复为预设的默认参数（新用户初始配置）">恢复默认配置</button>
        </div>

      </div>
    </div>
  )
}

// 基准测试子组件：运行当前画布在不同组合下的耗时与步数
function Benchmark({ flags, setFlag }){
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState([])

  const labelFor = (cfg)=>cfg.label

  const findLayeredVariant = (name)=>{
    if(!name || name==='none') return null
    if(/^layered_/.test(name)) return name
    const m = /^pdb_([A-Za-z0-9_]+)_max$/.exec(name)
    if(m){
      const suffix = m[1]
      const layered = `layered_pdb_${suffix}_max`
      const names = (()=>{ try { return listHeuristicNames() } catch { return [] } })()
      return names.includes(layered) ? layered : null
    }
    if(name==='pdb6x6_max'){
      const layered = 'layered_pdb_6x6_max'
      const names = (()=>{ try { return listHeuristicNames() } catch { return [] } })()
      return names.includes(layered) ? layered : null
    }
    return null
  }

  const toNonLayered = (name)=>{
    if(!name || name==='none') return name
    if(/^layered_pdb_([A-Za-z0-9_]+)_max$/.test(name)){
      const suf = name.replace(/^layered_pdb_/,'').replace(/_max$/,'')
      return `pdb_${suf}_max`
    }
    return name
  }

  const runBench = async () => {
    try {
      setRunning(true); setResults([])
      const tris = typeof window !== 'undefined' ? (window.__CURRENT_TRIANGLES__ || []) : []
      const palette = typeof window !== 'undefined' ? (window.__CURRENT_PALETTE__ || []) : []
      if(!Array.isArray(tris) || tris.length===0){ alert('当前画布数据不可用，无法运行基准。'); setRunning(false); return }
      const lightTris = tris.map(t=>({ id:t.id, neighbors:t.neighbors, color:t.color, deleted:!!t.deleted }))
      const originalFlags = { ...(window.SOLVER_FLAGS || {}) }

      const baselineHeur = toNonLayered(flags.heuristicName)
      const layeredHeur = findLayeredVariant(flags.heuristicName)
      const configs = []
      configs.push({ label:'UCB 关 + 非分层启发式', patch:{ enableLearningPrioritizer:false, heuristicName: baselineHeur, useDFSFirst:false, returnFirstFeasible:false } })
      configs.push({ label:'UCB 开 + 非分层启发式', patch:{ enableLearningPrioritizer:true, heuristicName: baselineHeur, useDFSFirst:false, returnFirstFeasible:false } })
      if(layeredHeur && layeredHeur!==baselineHeur){
        configs.push({ label:'UCB 关 + 分层启发式（max，可采纳）', patch:{ enableLearningPrioritizer:false, heuristicName: layeredHeur, useDFSFirst:false, returnFirstFeasible:false } })
        configs.push({ label:'UCB 开 + 分层启发式（max，可采纳）', patch:{ enableLearningPrioritizer:true, heuristicName: layeredHeur, useDFSFirst:false, returnFirstFeasible:false } })
      }

      const out = []
      for(const cfg of configs){
        const nextFlags = { ...flags, ...cfg.patch }
        try {
          window.SOLVER_FLAGS = nextFlags
          try { window.__solverWorker?.postMessage({ type:'set_flags', flags: nextFlags }) } catch {}
          const t0 = performance.now()
          const res = await (window.Solver_minStepsAuto?.(lightTris, palette, Math.max(1, flags.parallelWorkers||1), null, Infinity) || Promise.resolve({ minSteps: NaN }))
          const t1 = performance.now()
          const steps = typeof res?.minSteps === 'number' ? res.minSteps : NaN
          out.push({ label: labelFor(cfg), ms: Math.round(t1-t0), steps })
          setResults([...out])
        } catch (e) {
          out.push({ label: labelFor(cfg), ms: NaN, steps: NaN, error: String(e?.message||e) })
          setResults([...out])
        }
      }

      // 恢复原始 flags
      window.SOLVER_FLAGS = originalFlags
      try { window.__solverWorker?.postMessage({ type:'set_flags', flags: originalFlags }) } catch {}
      setRunning(false)
    } catch (e){
      console.warn('基准运行异常：', e)
      setRunning(false)
    }
  }

  return (
    <div style={{ gridColumn:'1 / -1' }}>
      <div style={{ display:'flex', alignItems:'center', gap:'.5rem', marginBottom:'.5rem' }}>
        <button disabled={running} onClick={runBench}>{running? '正在运行…' : '运行基准（UCB/分层 PDB）'}</button>
        <div style={{ fontSize:'12px', color:'#93a0b7' }}>对当前画布运行不同开关组合，统计耗时与最短步数。</div>
      </div>
      {results.length>0 && (
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:'6px' }}>
          <div style={{ fontWeight:600, color:'#a9b3c9' }}>配置</div>
          <div style={{ fontWeight:600, color:'#a9b3c9' }}>耗时（ms）</div>
          <div style={{ fontWeight:600, color:'#a9b3c9' }}>最短步数</div>
          {results.map((r,i)=> (
            <>
              <div key={`c${i}`} style={{ color:'#cbd3e1' }}>{r.label}</div>
              <div key={`m${i}`} style={{ color:'#cbd3e1' }}>{Number.isFinite(r.ms)? r.ms : '-'}</div>
              <div key={`s${i}`} style={{ color:'#cbd3e1' }}>{Number.isFinite(r.steps)? r.steps : '-'}</div>
            </>
          ))}
        </div>
      )}
    </div>
  )
}