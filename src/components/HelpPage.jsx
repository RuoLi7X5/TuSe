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
        <Section title="使用流程">
          <div>
            1.上传图片(截图尽量只保留题目区域)。否则需要手动框选并删除多余色块区域。
          </div>
          <div>
            2.输入颜色种类
          </div>
          <div>
            3.点击几何校准
          </div>
          <div>
            4.输入求解步骤上限，保存编辑
          </div>
          <div>
            5.点击自动求解即可开始进行求解
          </div>
          <br/>
          <div>
            性能参数一般不需要更改设置
          </div>
        </Section>
        <Section title="快捷键与操作（Shortcut）">
          <div style={{ fontWeight:'bold', marginBottom:'4px' }}>选择与编辑</div>
          <div>Shift + 点击：多选/取消多选三角形</div>
          <div>Ctrl + 点击：选中与该三角形颜色相同且相连的所有区域（连通域选择）</div>
          <div>鼠标右键：在框选/套索绘制完成后，选中范围内的所有三角形</div>
          <div style={{ fontWeight:'bold', marginTop:'8px', marginBottom:'4px' }}>画布视图</div>
          <div>WASD / 方向键：平移画布视角</div>
          <div>鼠标中键 / 按住空格+左键拖拽：平移画布</div>
          <div>Ctrl + 鼠标滚轮：缩放画布（以鼠标为中心）</div>
          <div>双指捏合（触屏）：缩放画布</div>
          <div style={{ fontWeight:'bold', marginTop:'8px', marginBottom:'4px' }}>通用</div>
          <div>Ctrl + Z：撤销上一步操作</div>
          <div>Ctrl + Y / Ctrl + Shift + Z：重做</div>
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
        {/* 已移除前台“总站（学习模型聚合）”入口；学习数据仅在后台管理员页面展示 */}
      </div>
    </div>
  )
}