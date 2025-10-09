import React, { useCallback } from 'react'

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <h3 style={{ margin: '0 0 .5rem 0', fontSize: '14px', color: 'var(--muted)' }}>{title}</h3>
      <div style={{ fontSize: '13px', lineHeight: 1.6 }}>{children}</div>
    </div>
  )
}

export default function HelpPage() {
  const onBack = useCallback(() => {
    try {
      if (window.history.length > 1) {
        window.history.back()
      } else {
        window.location.hash = ''
      }
    } catch {
      window.location.hash = ''
    }
  }, [])

  return (
    <div style={{ maxWidth: '980px', margin: '0 auto', padding: '1.5rem', color: 'var(--text)' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0, fontSize: '16px', color: 'var(--muted)' }}>说明 / 参数手册</h2>
        <button onClick={onBack} className="small-btn" style={{ fontSize:'12px' }}>返回</button>
      </div>

      <div className="panel" style={{ background:'var(--panel)' }}>
        <Section title="使用说明（快速上手）">
          <div>
            1. 截图信息尽量只保留相关内容，避免多余元素；否则识别后需要手动框选并删除无关区域。
          </div>
          <div>
            2. 在画布上点击 A 区域的任意三角形，在右侧颜色集合选择要泼涂的颜色，点击“泼涂”，即可将 A 的联通区域统一为该颜色。
          </div>
          <div style={{ color:'var(--muted)' }}>
            （识别阶段可能因图片的细微色差将同一种颜色分为多种。可先用泼涂保留想要的颜色，再点击“选择同色”快速选中所有同色区域，随后继续泼涂统一。）
          </div>
          <div>
            3. 输入步数限制（保证在该步数内有解），性能参数可按需要自行调节。
          </div>
          <div>
            4. 点击“自动求解”开始计算。
          </div>
          <div>
            5. 若参数设置有疑问，请查看下方详细说明与建议。
          </div>
        </Section>
        <Section title="页面导航">
          <div>
            - 当前为帮助子页。点击右上角“返回”回到主页面。
          </div>
        </Section>

        <Section title="参数总览（与性能调节窗口一致）">
          <div style={{ fontWeight:'bold' }}>进度与时间预算</div>
          <div>组件阶段进度节流（ms）：减少状态频繁刷新造成的卡顿。</div>
          <div>DFS 阶段进度节流（ms）：在深度优先阶段控制进度更新频率。</div>
          <div>预处理阶段时间预算（ms）：限制预处理耗时，保证可响应性。</div>
          <div>工作线程时间预算（ms）：限制单次求解耗时，提升页面流畅度。</div>
          <div style={{ fontWeight:'bold' }}>基本搜索策略</div>
          <div>启用下界（启发式剪枝）：用评估函数过滤劣解，缩小搜索空间。</div>
          <div>一步前瞻 / 两步前瞻：扩张前做前瞻评估，改进方向选择。</div>
          <div>增量扩张：优先能带来显著收益的扩张，减少无效尝试。</div>
          <div>束搜索与束宽：保留若干最优候选继续搜索，束宽越大越耗时。</div>
          <div>最佳优先：优先尝试评分最高的候选路径。</div>
          <div>桥接优先：优先形成连接不同区域的“桥”，提升连通性。</div>
          <div>零扩张过滤：过滤收益为 0 的扩张尝试。</div>
          <div>先用 DFS 找任意可行解：快速获取可行方案作为基准。</div>
          <div>找到可行解立即返回：仅需可行性时加速返回。</div>
          <div style={{ fontWeight:'bold' }}>评分与权重</div>
          <div>邻接后权重：扩张后依据相邻关系提升评分，鼓励紧凑区域。</div>
          <div>边界权重：调节靠近边界的选择倾向。</div>
          <div>桥接权重：提高连接不同区域的选择得分。</div>
          <div>闸门权重：强调关键通道位置的扩张收益。</div>
          <div>丰富度权重：偏好颜色分布更丰富的状态。</div>
          <div>双前沿权重：考虑两条前沿的协同优化。</div>
          <div>类别权重（边界/桥接/丰富度）：细粒度调节三类倾向。</div>
          <div>维度权重（扩张/连通/阻隔）：从三个维度综合评估路径质量。</div>
          <div style={{ fontWeight:'bold' }}>稀有颜色与扩张过滤</div>
          <div>稀有颜色频率占比阈值 / 绝对数量阈值：界定“稀有色”。</div>
          <div>稀有色允许的最小桥接分 / 闸门分：避免过低质量的稀有色桥接/闸门。</div>
          <div>最小扩张比例（Delta/Region）：过滤收益过低的扩张。</div>
          <div style={{ fontWeight:'bold' }}>路径优化</div>
          <div>局部窗口大小：窗口范围内进行局部重排。</div>
          <div>启用窗口重排：允许在窗口内重排步骤以改进路径。</div>
          <div>启用低优先移除：移除评分较低的步骤提升整体质量。</div>
          <div>交换尝试回合数：控制重排/交换的尝试次数与开销。</div>
          <div style={{ color:'var(--muted)' }}>
            说明：如遇参数含义疑惑或效果异常，请以本节与性能调节窗口的中文提示为准；可先减小束宽、提高节流并放宽稀有色限制后再观察。
          </div>
        </Section>

        <Section title="相互影响与典型触发">
          <div>
            - 当 `stepLimit` 有限时，主搜索未统一会触发 DFS 限深回退；日志显示阶段 `dfs`，`queue=0` 代表使用栈而非队列。
          </div>
          <div>
            - 预处理很快结束时仍会输出 `components_done`，便于确认阶段完成与分量数量。
          </div>
          <div>
            - 启用 Beam 与 Incremental 可在有限 `stepLimit` 下提升最优更新频率，降低“空转”。
          </div>
        </Section>

        <Section title="日志字段解释">
          <div>
            - `phase`：当前阶段（如 `components_build`、`components_done`、`dfs`、`best_update`、`solution`）。
          </div>
          <div>
            - `nodes`：累计探索节点数；`solutions`：当前候选分支数；`queue`：队列大小（DFS 为 0）。
          </div>
          <div>
            - `perf.enqueued` / `perf.expanded` / `perf.filteredZero`：性能计数（入队、扩张、零扩张过滤）。
          </div>
          <div>
            - `components` / `count`：连通分量数量与大小摘要；在 `components_done` 汇总输出。
          </div>
        </Section>

        <Section title="推荐组合（两种工作模式）">
          <div>
            - 约束最短模式：`stepLimit=Infinity`、`enableBeam=true`、`beamWidth=32`、`lbImproveMin≈0.5`、`enableIncremental=true`；
            `preprocessTimeBudgetMs=120000`、`workerTimeBudgetMs=180000–300000`。
          </div>
          <div>
            - 探索/快速可行模式：`useDFSFirst=true`、`returnFirstFeasible=true`、`stepLimit≈12–48`，并保留 `enableZeroExpandFilter`；
            如需更稳，增加 `beamWidth` 与 `enableIncremental`。
          </div>
        </Section>

        <Section title="常见问题">
          <div>
            - 为什么 `queue=0`？DFS 使用递归栈非队列；队列指标只对 BFS/Best-First 有意义。
          </div>
          <div>
            - 预处理为何很短？图像简单或颜色集中时分量识别很快；现在会输出 `components_done` 标记完成。
          </div>
          <div>
            - 如何避免 DFS？将 `stepLimit` 设为较大或无穷，并启用 Beam 与增量剪枝。
          </div>
        </Section>

        <Section title="联系作者">
          <div>
            联系作者：加QQ：3188789174 备注来意
          </div>
        </Section>
      </div>
    </div>
  )
}