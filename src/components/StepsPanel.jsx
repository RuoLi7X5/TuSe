export default function StepsPanel({ steps }) {
  if (!steps || steps.length === 0) return (
    <div className="steps" style={{ color: '#a9b3c9' }}>暂无步骤，点击“自动求解”生成最少步骤方案</div>
  )
  return (
    <div className="steps">
      {steps.map((branch, i) => (
        <div key={i}>
          <div style={{ marginBottom: '.25rem', color: '#a9b3c9' }}>分支 {i+1}（步数：{branch.path.length}）</div>
          <div style={{ margin: '.25rem 0', fontSize: '.9rem' }}>
            步骤：{branch.path.map((c, idx) => (
              <span key={idx} style={{ display:'inline-flex', alignItems:'center', gap:'.25rem', marginRight: '.5rem' }}>
                <span style={{ width:'14px', height:'14px', background:c, border:'1px solid #000', display:'inline-block' }} />
                <span style={{ color: '#a9b3c9' }}>{c}</span>
                {idx < branch.path.length-1 ? <span style={{ margin:'0 .25rem' }}>→</span> : null}
              </span>
            ))}
          </div>
          <div style={{ display:'grid', gap:'.5rem' }}>
            {branch.images.map((src, j) => (
              <img key={j} className="step-thumb" src={src} alt={`step ${j+1}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}