import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { makeGraphSignature, getUCBStats, putUCBStats, getStrategySummary, listGraphs } from '../utils/telemetry'

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
  const [sigInput, setSigInput] = useState('')
  const [stats, setStats] = useState(null)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [listLoading, setListLoading] = useState(false)
  const [graphList, setGraphList] = useState([])
  const [filterHasStrategy, setFilterHasStrategy] = useState(false)

  useEffect(() => {
    try{
      const tris = (typeof window!=='undefined' ? (window.__CURRENT_TRIANGLES__||[]) : [])
      const pal = (typeof window!=='undefined' ? (window.__CURRENT_PALETTE__||[]) : [])
      let s = ''
      if (Array.isArray(tris) && tris.length > 0) {
        s = makeGraphSignature(tris, pal)
      } else {
        s = (typeof window!=='undefined' ? (window.__LAST_SIG__ || localStorage.getItem('lastSignature') || '') : '')
      }
      setSig(s)
      setSigInput(s)
    }catch(e){ setSig((typeof window!=='undefined' ? (localStorage.getItem('lastSignature') || '') : '')) }
  }, [])

  const loadGraphList = useCallback(async () => {
    setListLoading(true)
    try { const arr = await listGraphs(50); setGraphList(Array.isArray(arr)?arr:[]) } catch { setGraphList([]) }
    finally { setListLoading(false) }
  }, [])
  useEffect(()=>{ loadGraphList() }, [loadGraphList])

  // 统一签名解析：若提供 overrideSig 则直接使用；否则仅在未提供时回退画布/缓存
  const resolveSignature = useCallback((overrideSig)=>{
    if (overrideSig) return overrideSig
    if (sig) return sig
    try {
      const tris = (typeof window!=='undefined' ? (window.__CURRENT_TRIANGLES__||[]) : [])
      const pal = (typeof window!=='undefined' ? (window.__CURRENT_PALETTE__||[]) : [])
      if (Array.isArray(tris) && tris.length > 0) {
        return makeGraphSignature(tris, pal)
      }
      const fallback = (typeof window!=='undefined' ? (window.__LAST_SIG__ || localStorage.getItem('lastSignature')) : null)
      if (fallback) return fallback
    } catch {}
    return ''
  }, [sig])

  const loadStats = useCallback(async (overrideSig) => {
    const s = resolveSignature(overrideSig)
    setSig(s)
    if(!s) return
    setLoading(true); setError('')
    try{
      const remote = await getUCBStats(s)
      setStats(remote || null)
    }catch(e){ setError('无法拉取总站统计'); }
    finally{ setLoading(false) }
  }, [resolveSignature])

  useEffect(()=>{ loadStats() }, [loadStats])

  const loadSummary = useCallback(async (overrideSig) => {
    const s = resolveSignature(overrideSig)
    setSig(s)
    if(!s) return
    setLoadingSummary(true)
    try{
      const res = await getStrategySummary(s)
      setSummary(res || null)
    }catch{}
    finally{ setLoadingSummary(false) }
  }, [resolveSignature])

  useEffect(()=>{ loadSummary() }, [loadSummary])

  const onBack = useCallback(() => {
    try { window.location.hash = '#/help' } catch { window.location.hash = '#/help' }
  }, [])
  const goAdmin = useCallback((tab) => {
    try { if(tab) localStorage.setItem('adminTab', tab) } catch {}
    try { window.location.hash = '#/admin' } catch {}
  }, [])

  const onLoadSig = useCallback(async () => {
    const s = (sigInput||'').trim()
    if (!s) return
    setSig(s)
    await loadStats(s)
    await loadSummary(s)
  }, [sigInput, loadStats, loadSummary])

  const onUseCurrent = useCallback(async () => {
    try {
      const tris = (typeof window!=='undefined' ? (window.__CURRENT_TRIANGLES__||[]) : [])
      const pal = (typeof window!=='undefined' ? (window.__CURRENT_PALETTE__||[]) : [])
      let s = ''
      if (Array.isArray(tris) && tris.length > 0) s = makeGraphSignature(tris, pal)
      else {
        const fallback = (typeof window!=='undefined' ? (window.__LAST_SIG__ || localStorage.getItem('lastSignature') || '') : '')
        s = fallback
      }
      if (!s) return
      setSig(s); setSigInput(s)
      await loadStats(s); await loadSummary(s)
    } catch {}
  }, [loadStats, loadSummary])

  const onSync = useCallback(async () => {
    // 计算或回退签名，优先使用最新画布；否则使用最近缓存
    let s = sig
    try {
      const tris = (typeof window!=='undefined' ? (window.__CURRENT_TRIANGLES__||[]) : [])
      const pal = (typeof window!=='undefined' ? (window.__CURRENT_PALETTE__||[]) : [])
      if (Array.isArray(tris) && tris.length > 0) {
        s = makeGraphSignature(tris, pal)
      } else {
        const fallback = (typeof window!=='undefined' ? (window.__LAST_SIG__ || localStorage.getItem('lastSignature')) : null)
        if (fallback) s = fallback
      }
      setSig(s)
    } catch {}
    if(!s) return
    setSyncing(true); setError('')
    try{
      // 从 localStorage 读取当前图的 UCB 学习统计
      const raw = (typeof window!=='undefined') ? localStorage.getItem('ucb:'+s) : null
      if(!raw){ throw new Error('本地未找到 UCB 学习数据') }
      const data = JSON.parse(raw)
      const counts = {}; for(const [c,n] of (Array.isArray(data?.counts)?data.counts:[])){ counts[c] = Number(n)||0 }
      const rewards = {}; for(const [c,r] of (Array.isArray(data?.rewards)?data.rewards:[])){ rewards[c] = Number(r)||0 }
      const totalPulls = Number(data?.totalPulls)||0
      await putUCBStats(s, { counts, rewards, totalPulls })
      await loadStats(s)
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

  const filteredGraphList = useMemo(()=>{
    const base = Array.isArray(graphList) ? graphList : []
    return filterHasStrategy ? base.filter(g=>g.has_strategy) : base
  }, [graphList, filterHasStrategy])

  return (
    <div style={{ maxWidth:'980px', margin:'0 auto', padding:'1.5rem', color:'var(--text)' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1rem' }}>
        <h2 style={{ margin:0, fontSize:'16px', color:'var(--muted)' }}>总站 / 学习模型聚合</h2>
        <a href="#/help" className="small-btn" style={{ fontSize:'12px', textDecoration:'none' }}>返回说明</a>
      </div>
      <div style={{ display:'flex', gap:'6px', marginBottom:'12px' }}>
        {['graphs','strategies','runs','events','caches','recommendations','ucbs'].map(t => (
          <button
            key={t}
            onClick={()=>goAdmin(t)}
            style={{ background:'#2a3448', border:'1px solid #3a4260', color:'#e8eef9' }}
          >{t}</button>
        ))}
        <div style={{ flex:1 }} />
        <a href="#/admin" style={{ textDecoration:'none', color:'#93a0b7' }}>打开管理后台</a>
      </div>

      <div className="panel" style={{ background:'var(--panel)', marginBottom:'16px' }}>
        <div style={{ marginBottom:'.5rem', fontSize:'13px', color:'var(--muted)' }}>选择签名（无需理解签名本身）：可直接点击下方“查看摘要”。</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr auto auto auto', gap:'8px', alignItems:'center' }}>
          <input
            type="text"
            value={sigInput}
            onChange={e=>setSigInput(e.target.value)}
            placeholder="粘贴或输入图签名（可选）"
            style={{ width:'100%', padding:'8px', border:'1px solid var(--panel-border)', borderRadius:4, background:'var(--bg)', fontFamily:'monospace' }}
          />
          <div
            role="button"
            tabIndex={0}
            className="hub-btn"
            onClick={onLoadSig}
            style={{ background:'#1a1f2b', color:'var(--text)', border:'1px solid var(--border)', borderRadius:8 }}
          >加载</div>
          <div
            role="button"
            tabIndex={0}
            className="hub-btn"
            onClick={onUseCurrent}
            style={{ background:'#1a1f2b', color:'var(--text)', border:'1px solid var(--border)', borderRadius:8 }}
          >使用当前画布</div>
          <div
            role="button"
            tabIndex={listLoading? -1 : 0}
            aria-disabled={listLoading? 'true' : undefined}
            className="hub-btn"
            onClick={(e)=>{ if(listLoading){ e.preventDefault(); e.stopPropagation(); return } loadGraphList() }}
            style={{ background:'#1a1f2b', color:'var(--text)', border:'1px solid var(--border)', borderRadius:8 }}
          >刷新列表{listLoading?'…':''}</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:'12px', marginTop:'8px' }}>
          <label style={{ fontSize:'12px', color:'var(--muted)' }}>
            <input type="checkbox" checked={filterHasStrategy} onChange={e=>setFilterHasStrategy(!!e.target.checked)} style={{ marginRight:'4px' }} />只看有摘要
          </label>
          <span style={{ fontSize:'12px', color:'var(--muted)' }}>提示：直接点击列表中的签名或“查看摘要”，无需输入。</span>
        </div>
        <div style={{ marginTop:'10px', color:'var(--muted)' }}>最近图：</div>
        <div style={{ borderTop:'1px solid var(--panel-border)' }}>
          {filteredGraphList.length===0 ? (
            <div style={{ color:'var(--muted)', padding:'8px 0' }}>无</div>
          ) : filteredGraphList.slice(0,20).map(g=> (
            <div key={g.graph_signature} style={{ display:'grid', gridTemplateColumns:'1fr 120px 80px 160px', gap:'8px', alignItems:'center', padding:'6px 0', borderBottom:'1px solid var(--panel-border)' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                <span style={{ fontFamily:'monospace', cursor:'pointer', color:'#89f' }} onClick={()=>{ setSig(g.graph_signature); setSigInput(g.graph_signature); loadStats(g.graph_signature); loadSummary(g.graph_signature) }}>{g.graph_signature}</span>
              </div>
              <div style={{ color:'var(--muted)' }}>组件：{g.n_components ?? '-'}</div>
              <div style={{ color:'var(--muted)' }}>调色板：{g.palette_size ?? '-'}</div>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                <span style={{ color: g.has_strategy? '#6f6' : 'var(--muted)' }}>{g.has_strategy? '已上传摘要' : '暂无摘要'}</span>
                <span role="button" tabIndex={0} style={{ fontSize:'12px', color:'#9cf', cursor:'pointer' }} onClick={()=>{ setSig(g.graph_signature); setSigInput(g.graph_signature); loadSummary(g.graph_signature) }}>查看摘要</span>
                <span role="button" tabIndex={0} style={{ fontSize:'12px', color:'#9cf', cursor:'pointer' }} onClick={()=>{ setSig(g.graph_signature); setSigInput(g.graph_signature); loadStats(g.graph_signature) }}>查看统计</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ background:'var(--panel)' }}>
        <div style={{ marginBottom:'.75rem', fontSize:'13px' }}>
          <div>当前图签名：<span style={{ fontFamily:'monospace' }}>{sig||'(无)'}</span></div>
          <div style={{ color:'var(--muted)' }}>提示：装载同图后本页自动显示总站统计；如需手动上传，点击“同步到总站”。</div>
        </div>
        <div style={{ display:'flex', gap:'12px', marginBottom:'1rem' }}>
          <div
            role="button"
            tabIndex={loading? -1 : 0}
            aria-disabled={loading? 'true' : undefined}
            className="hub-btn"
            onKeyDown={(e)=>{ if(!loading && (e.key==='Enter'||e.key===' ')) { e.preventDefault(); loadStats(sig) } }}
            onClick={(e)=>{ if(loading){ e.preventDefault(); e.stopPropagation(); return } loadStats(sig) }}
            style={{ background:'#1a1f2b', color:'var(--text)', border:'1px solid var(--border)', borderRadius:8 }}
          >刷新统计{loading?'…':''}</div>
          <div
            role="button"
            tabIndex={(syncing||!sig)? -1 : 0}
            aria-disabled={(syncing||!sig)? 'true' : undefined}
            className="hub-btn primary"
            onKeyDown={(e)=>{ if(!(syncing||!sig) && (e.key==='Enter'||e.key===' ')) { e.preventDefault(); onSync() } }}
            onClick={(e)=>{ if(syncing||!sig){ e.preventDefault(); e.stopPropagation(); return } onSync() }}
            style={{ background:'#1a1f2b', color:'var(--text)', border:'1px solid var(--border)', borderRadius:8 }}
          >同步到总站{syncing?'…':''}</div>
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
            <div
              role="button"
              tabIndex={loadingSummary? -1 : 0}
              aria-disabled={loadingSummary? 'true' : undefined}
              className="hub-btn"
              onKeyDown={(e)=>{ if(!loadingSummary && (e.key==='Enter'||e.key===' ')) { e.preventDefault(); loadSummary(sig) } }}
              onClick={(e)=>{ if(loadingSummary){ e.preventDefault(); e.stopPropagation(); return } loadSummary(sig) }}
              style={{ background:'#1a1f2b', color:'var(--text)', border:'1px solid var(--border)', borderRadius:8 }}
            >刷新摘要{loadingSummary?'…':''}</div>
          </div>
        </div>
        {!summary ? (
          <div style={{ color:'var(--muted)', padding:'8px 0' }}>暂无摘要（自动上传在求解完成后触发；也可在上方“最近图”直接点“查看摘要”）</div>
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
        <div style={{ marginTop:'8px', color:'var(--muted)' }}>说明：摘要在“自动求解 / 继续最短 / 路径优化”完成后自动上传；可通过上方签名选择查看任意图。</div>
      </div>
    </div>
  )
}