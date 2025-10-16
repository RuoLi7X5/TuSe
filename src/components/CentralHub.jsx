import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { makeGraphSignature, getUCBStats, putUCBStats, getStrategySummary } from '../utils/telemetry'

function StatRow({ color, count, reward }){
  const avg = useMemo(()=>{
    const n = Number(count)||0; const r = Number(reward)||0
    return n>0 ? (r/n).toFixed(3) : '-'
  }, [count, reward])
  return (
    <div style={{ display:'grid', gridTemplateColumns:'120px 100px 100px 80px', gap:'8px', alignItems:'center', padding:'6px 0', borderBottom:'1px solid var(--panel-border)' }}>
      <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
        <span style={{ width:16, height:16, borderRadius:3, background: color, border:'1px solid rgba(0,0,0,.1)' }} />
        <span style={{ fontFamily:'monospace' }}>{color}</span>
      </div>
      <div>{Number(count)||0}</div>
      <div>{Number(reward)?.toFixed ? Number(reward).toFixed(3) : (Number(reward)||0)}</div>
      <div style={{ color:'var(--muted)' }}>{avg}</div>
    </div>
  )
}

export default function CentralHub(){
  const [sig, setSig] = useState('')
  const [stats, setStats] = useState(null)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    try{
      const tris = (typeof window!=='undefined' ? (window.__CURRENT_TRIANGLES__||[]) : [])
      const pal = (typeof window!=='undefined' ? (window.__CURRENT_PALETTE__||[]) : [])
      const s = makeGraphSignature(tris, pal)
      setSig(s)
    }catch(e){ setSig('') }
  }, [])

  const loadStats = useCallback(async () => {
    if(!sig) return
    setLoading(true); setError('')
    try{
      const remote = await getUCBStats(sig)
      setStats(remote || null)
    }catch(e){ setError('无法拉取总站统计'); }
    finally{ setLoading(false) }
  }, [sig])

  useEffect(()=>{ loadStats() }, [loadStats])

  const loadSummary = useCallback(async () => {
    if(!sig) return
    setLoadingSummary(true)
    try{
      const s = await getStrategySummary(sig)
      setSummary(s || null)
    }catch{}
    finally{ setLoadingSummary(false) }
  }, [sig])

  useEffect(()=>{ loadSummary() }, [loadSummary])

  const onBack = useCallback(() => {
    try { window.location.hash = '#/help' } catch { window.location.hash = '#/help' }
  }, [])

  const onSync = useCallback(async () => {
    if(!sig) return
    setSyncing(true); setError('')
    try{
      // 从 localStorage 读取当前图的 UCB 学习统计
      const raw = (typeof window!=='undefined') ? localStorage.getItem('ucb:'+sig) : null
      if(!raw){ throw new Error('本地未找到 UCB 学习数据') }
      const data = JSON.parse(raw)
      const counts = {}; for(const [c,n] of (Array.isArray(data?.counts)?data.counts:[])){ counts[c] = Number(n)||0 }
      const rewards = {}; for(const [c,r] of (Array.isArray(data?.rewards)?data.rewards:[])){ rewards[c] = Number(r)||0 }
      const totalPulls = Number(data?.totalPulls)||0
      await putUCBStats(sig, { counts, rewards, totalPulls })
      await loadStats()
    }catch(e){ setError(e?.message || '上传失败'); }
    finally{ setSyncing(false) }
  }, [sig, loadStats])

  const list = useMemo(()=>{
    if(!stats) return []
    const colors = Object.keys(stats.counts||{})
    colors.sort((a,b)=> (stats.counts[b]||0) - (stats.counts[a]||0))
    return colors.map(c=>({ color:c, count: stats.counts?.[c]||0, reward: stats.rewards?.[c]||0 }))
  }, [stats])

  const palette = (typeof window!=='undefined' ? (window.__CURRENT_PALETTE__||[]) : [])
  const colorRows = useMemo(()=>{
    const cc = summary?.color_counts || {}
    const keys = Object.keys(cc)
    keys.sort((a,b)=> (cc[b]||0)-(cc[a]||0))
    return keys.map(k=>({
      key: k,
      count: cc[k]||0,
      swatch: (palette && palette.length>0 && typeof k==='string' && /^#|rgb|hsl|[a-zA-Z]/.test(k)) ? k : (palette?.[Number(k)] || k)
    }))
  }, [summary, palette])

  return (
    <div style={{ maxWidth:'980px', margin:'0 auto', padding:'1.5rem', color:'var(--text)' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1rem' }}>
        <h2 style={{ margin:0, fontSize:'16px', color:'var(--muted)' }}>总站 / 学习模型聚合</h2>
        <button onClick={onBack} className="small-btn" style={{ fontSize:'12px' }}>返回说明</button>
      </div>

      <div className="panel" style={{ background:'var(--panel)' }}>
        <div style={{ marginBottom:'.75rem', fontSize:'13px' }}>
          <div>当前图签名：<span style={{ fontFamily:'monospace' }}>{sig||'(无)'}</span></div>
          <div style={{ color:'var(--muted)' }}>提示：装载同图后本页自动显示总站统计；如需手动上传，点击“同步到总站”。</div>
        </div>
        <div style={{ display:'flex', gap:'12px', marginBottom:'1rem' }}>
          <button onClick={loadStats} disabled={loading}>刷新统计{loading?'…':''}</button>
          <button onClick={onSync} className="primary" disabled={syncing || !sig}>同步到总站{syncing?'…':''}</button>
        </div>
        {error ? <div style={{ color:'#e67', marginBottom:'8px' }}>{error}</div> : null}
        <div style={{ fontWeight:'bold', marginBottom:'8px' }}>颜色统计（次数 / 累计奖励 / 平均奖励）</div>
        <div style={{ borderTop:'1px solid var(--panel-border)' }}>
          {list.length===0 ? (
            <div style={{ color:'var(--muted)', padding:'8px 0' }}>{stats? '暂无数据' : '未连接或无数据'}</div>
          ) : (
            list.map(row => <StatRow key={row.color} color={row.color} count={row.count} reward={row.reward} />)
          )}
        </div>
        <div style={{ marginTop:'12px', color:'var(--muted)' }}>总试次：{Number(stats?.totalPulls)||0}</div>
      </div>

      <div className="panel" style={{ background:'var(--panel)', marginTop:'16px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontWeight:'bold' }}>特征与策略摘要</div>
          <div>
            <button onClick={loadSummary} disabled={loadingSummary}>刷新摘要{loadingSummary?'…':''}</button>
          </div>
        </div>
        {!summary ? (
          <div style={{ color:'var(--muted)', padding:'8px 0' }}>暂无摘要（自动上传在求解完成后触发）</div>
        ) : (
          <div style={{ marginTop:'8px' }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:'8px' }}>
              <div style={{ color:'var(--muted)' }}>模式</div><div style={{ fontFamily:'monospace' }}>{summary.mode||'-'}</div>
              <div style={{ color:'var(--muted)' }}>起点</div><div style={{ fontFamily:'monospace' }}>{summary.start_id??'-'}</div>
              <div style={{ color:'var(--muted)' }}>起点颜色</div><div style={{ fontFamily:'monospace' }}>{summary.start_color??'-'}</div>
              <div style={{ color:'var(--muted)' }}>路径长度</div><div style={{ fontFamily:'monospace' }}>{summary.path_len??0}</div>
              <div style={{ color:'var(--muted)' }}>颜色切换次数</div><div style={{ fontFamily:'monospace' }}>{summary.transitions_count??0}</div>
              <div style={{ color:'var(--muted)' }}>最长同色连段</div><div style={{ fontFamily:'monospace' }}>{summary.longest_streak??0}</div>
              <div style={{ color:'var(--muted)' }}>使用颜色数</div><div style={{ fontFamily:'monospace' }}>{summary.unique_colors_used??0}</div>
              <div style={{ color:'var(--muted)' }}>组件数</div><div style={{ fontFamily:'monospace' }}>{summary.features?.n_components??'-'}</div>
              <div style={{ color:'var(--muted)' }}>色彩熵</div><div style={{ fontFamily:'monospace' }}>{summary.features?.color_entropy?.toFixed ? summary.features.color_entropy.toFixed(3) : (summary.features?.color_entropy??'-')}</div>
            </div>
            <div style={{ marginTop:'10px', fontWeight:'bold' }}>路径颜色频次</div>
            <div style={{ borderTop:'1px solid var(--panel-border)' }}>
              {colorRows.length===0 ? (
                <div style={{ color:'var(--muted)', padding:'8px 0' }}>无</div>
              ) : colorRows.map(r=> (
                <div key={r.key} style={{ display:'grid', gridTemplateColumns:'120px 100px', gap:'8px', alignItems:'center', padding:'6px 0', borderBottom:'1px solid var(--panel-border)' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                    <span style={{ width:16, height:16, borderRadius:3, background: r.swatch, border:'1px solid rgba(0,0,0,.1)' }} />
                    <span style={{ fontFamily:'monospace' }}>{r.key}</span>
                  </div>
                  <div>{r.count}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ marginTop:'8px', color:'var(--muted)' }}>说明：摘要在“自动求解 / 继续最短 / 路径优化”完成后自动上传并在此展示。</div>
      </div>
    </div>
  )
}