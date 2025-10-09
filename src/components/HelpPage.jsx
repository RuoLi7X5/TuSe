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
        <Section title="页面导航">
          <div>
            - 当前为帮助子页。点击右上角“返回”回到主页面。
          </div>
        </Section>

        <Section title="参数总览（求解器核心）">
          <div>
            - `stepLimit`：搜索步数上限。小值更快，可能触发 DFS 限深回退；设为较大或无限以保障最短性。
          </div>
          <div>
            - `preprocessTimeBudgetMs`：预处理分量识别的时间预算。结束时会输出 `components_done` 概要。
          </div>
          <div>
            - `workerTimeBudgetMs`：Worker 求解整体时间预算。到时早停并返回当前最优或失败。
          </div>
          <div>
            - `useDFSFirst` / `returnFirstFeasible`：是否先进行 DFS、以及是否找到可行解就返回（非全局最短）。
          </div>
          <div>
            - `enableBeam` / `beamWidth`：启用束搜索与束宽。束越宽，保留的候选越多但更慢。
          </div>
          <div>
            - `enableIncremental`：增量邻域搜索，提升剪枝效率与连贯性。
          </div>
          <div>
            - `lbImproveMin`：启发式下界改善阈值（越大越保守，剪枝更激进）。
          </div>
          <div>
            - `enableZeroExpandFilter`：过滤零扩张分支（无进展的扩张），降低无效探索。
          </div>
          <div>
            - `adjAfterWeight` / `boundaryWeight` / `bridgeWeight` / `gateWeight` / `richnessWeight`：
            邻接、边界、桥、门、丰富度权重（影响候选排序与启发式评分）。
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
      </div>
    </div>
  )
}