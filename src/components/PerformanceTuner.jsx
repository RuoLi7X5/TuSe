import { useEffect, useMemo, useState } from 'react'

// 性能调节面板：集中管理求解器的所有可调参数
export default function PerformanceTuner({ onClose }) {
  const existing = typeof window !== 'undefined' ? (window.SOLVER_FLAGS || {}) : {}
  // 默认值（与 solver.js / solver-worker.js 保持一致）
  const defaults = useMemo(() => ({
    // 基本搜索策略
    enableLB: false,
    enableLookahead: false,
    enableLookaheadDepth2: false,
    enableIncremental: false,
    enableBeam: false,
    beamWidth: 12,
    enableBestFirst: false,
    enableBridgeFirst: false,
    enableZeroExpandFilter: true,
    useDFSFirst: false,
    returnFirstFeasible: false,
    logPerf: false,
    // 进度与时间预算（新）
    workerTimeBudgetMs: 60000,
    progressComponentsIntervalMs: 100,
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
    // 路径优化
    optimizeWindowSize: 5,
    optimizeEnableWindow: true,
    optimizeEnableRemoval: true,
    optimizeSwapPasses: 1,
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

  const onSave = () => {
    try {
      const next = { ...flags }
      window.SOLVER_FLAGS = next
      localStorage?.setItem('solverFlags', JSON.stringify(next))
      alert('参数已保存。下一次计算将使用新设置。')
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
      <div style={{ position: 'relative' }} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}>
        <div style={{ fontSize: '12px', color: '#a9b3c9', marginBottom: '4px' }}>{label}</div>
        {children}
        {hover && tooltip && (
          <div style={{ position:'absolute', zIndex:10, top:'100%', left:0, marginTop:'4px', background:'#0f1420', color:'#cbd3e1', border:'1px solid var(--border)', borderRadius:'6px', padding:'8px', fontSize:'12px', maxWidth:'420px', boxShadow:'0 4px 10px rgba(0,0,0,0.35)' }}>
            {tooltip}
          </div>
        )}
      </div>
    )
  }

  const BoolInput = ({ value, onChange }) => (
    <label style={{ display:'inline-flex', alignItems:'center', gap:'.5rem', cursor:'pointer' }}>
      <input type="checkbox" checked={!!value} onChange={e=>onChange(e.target.checked)} />
      <span style={{ color:'#cbd3e1' }}>{value? '开启' : '关闭'}</span>
    </label>
  )
  const NumInput = ({ value, onChange, step=1, min, max }) => (
    <input type="number" value={value} step={step} min={min} max={max} onChange={e=>onChange(parseFloat(e.target.value))} style={{ width:'100%', padding:'6px', borderRadius:'6px', border:'1px solid var(--border)', background:'#1a1f2b', color:'var(--text)' }} />
  )

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ width:'860px', maxWidth:'95vw', maxHeight:'85vh', overflow:'auto', background:'#0f1420', border:'1px solid var(--border)', borderRadius:'10px', padding:'16px' }}>
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
          <Field label="最佳优先（Best-First）" tooltip="效果：总是先扩张评分更高的节点，通常能更快逼近解。\n适用：大多数场景下建议开启。\n不适用：希望严格层次遍历（BFS）验证每层完整性时可关闭。">
            <BoolInput value={flags.enableBestFirst} onChange={v=>setFlag('enableBestFirst', v)} />
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

        <Section title="进度与时间预算">
          <Field label="工作线程时间预算（ms）" tooltip="效果：限制每轮自动求解在工作线程可用的总时间，超出后切换/早停。
建议：小图 20,000~40,000；中图 40,000~80,000；大图 80,000~180,000。
提示：值越小越早看到阶段切换和搜索节点进度。">
            <NumInput value={flags.workerTimeBudgetMs} onChange={v=>setFlag('workerTimeBudgetMs', v)} step={1000} min={1000} />
          </Field>
          <Field label="组件阶段进度节流（ms）" tooltip="效果：控制“components”阶段进度打点的最小间隔（毫秒）。
建议：100~200。若希望几乎每个组件都打印，可设为 0。">
            <NumInput value={flags.progressComponentsIntervalMs} onChange={v=>setFlag('progressComponentsIntervalMs', v)} step={50} min={0} />
          </Field>
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

      </div>
    </div>
  )
}