import { useEffect, useMemo, useRef, useState } from 'react'

// 简易总站（Admin）仪表：带顶部导航与各板块视图，支持事件流
export default function AdminDashboard(){
  const [tab, setTab] = useState(()=>{ try { return localStorage.getItem('adminTab') || 'graphs' } catch { return 'graphs' } })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [graphs, setGraphs] = useState([])
  const [strategies, setStrategies] = useState([])
  const [runs, setRuns] = useState([])
  const [events, setEvents] = useState([])
  const [caches, setCaches] = useState([])
  const [recs, setRecs] = useState([])
  const [ucbs, setUcbs] = useState([])

  const [selectedRunId, setSelectedRunId] = useState('')
  const sseRef = useRef(null)

  const serverBase = useMemo(() => {
    try {
      const flagsBase = (typeof window !== 'undefined' && window.SOLVER_FLAGS && window.SOLVER_FLAGS.serverBaseUrl) ? String(window.SOLVER_FLAGS.serverBaseUrl) : ''
      if (flagsBase) return flagsBase
      if (typeof window !== 'undefined' && window.location && window.location.origin && !/localhost/i.test(window.location.hostname)) return window.location.origin
      return 'http://localhost:3001'
    } catch { return 'http://localhost:3001' }
  }, [])
  const token = useMemo(() => {
    try { return (typeof window!=='undefined' ? (window.ADMIN_TOKEN || localStorage.getItem('adminToken') || '') : '') } catch { return '' }
  }, [])

  async function getJSON(path){
    setError('')
    const url = `${serverBase}${path}`
    const headers = token ? { Authorization: 'Bearer '+token } : {}
    const res = await fetch(url, { headers })
    if(!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  }

  const refresh = async () => {
    try {
      setLoading(true)
      const [g, s, r, c, rr, u] = await Promise.all([
        getJSON('/api/admin/graphs?limit=50'),
        getJSON('/api/admin/strategies?limit=50'),
        getJSON('/api/admin/runs?limit=50'),
        getJSON('/api/admin/caches?limit=50'),
        getJSON('/api/admin/recommendations?limit=50'),
        getJSON('/api/admin/ucbs?limit=50'),
      ])
      setGraphs(g||[]); setStrategies(s||[]); setRuns(r||[]); setCaches(c||[]); setRecs(rr||[]); setUcbs(u||[])
    } catch(e){ setError(String(e.message||e)) } finally { setLoading(false) }
  }

  useEffect(()=>{ refresh() }, [])

  // 订阅事件流（按选中的 run_id）
  useEffect(() => {
    try {
      if (!selectedRunId) return
      // 关闭旧流
      try { sseRef.current?.close?.() } catch {}
      const url = `${serverBase}/api/admin/events/stream?run_id=${encodeURIComponent(selectedRunId)}${token? `&token=${encodeURIComponent(token)}`:''}`
      const es = new EventSource(url)
      sseRef.current = es
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data)
          setEvents(prev => [...prev.slice(-399), data])
        } catch {}
      }
      es.onerror = () => { /* 静默重连 */ }
      return () => { try { es.close() } catch {} }
    } catch {}
  }, [selectedRunId])

  const ItemList = ({ items, cols }) => (
    <div style={{ display:'grid', gridTemplateColumns:`repeat(${cols||3}, 1fr)`, gap:'6px', alignItems:'start' }}>
      {(items||[]).map((it,i) => (
        <div key={i} style={{ background:'var(--panel)', padding:'8px', border:'1px solid var(--panel-border)', borderRadius:4 }}>
          <pre style={{ margin:0, whiteSpace:'pre-wrap', wordBreak:'break-word', fontSize:'12px', color:'#cbd3e1' }}>{JSON.stringify(it, null, 2)}</pre>
        </div>
      ))}
    </div>
  )

  return (
    <div style={{ padding:'12px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'12px' }}>
        <a href="#/hub" className="small-btn" style={{ fontSize:'12px', textDecoration:'none' }}>返回总站</a>
        <div style={{ flex:1 }} />
        <button onClick={refresh} disabled={loading}>{loading? '刷新中…' : '刷新'}</button>
        <span style={{ fontSize:'12px', color:'#93a0b7' }}>后端：{serverBase}</span>
        {token ? <span style={{ fontSize:'12px', color:'#7aa2f7' }}>已认证</span> : <span style={{ fontSize:'12px', color:'#d15b5b' }}>未认证</span>}
      </div>

       <div style={{ display:'flex', gap:'6px', marginBottom:'12px' }}>
        {['graphs','strategies','runs','events','caches','recommendations','ucbs'].map(t => (
          <button
            key={t}
            className={tab===t? 'primary' : ''}
            style={{ background:'#273245', border:'1px solid #3a4260', color: tab===t ? '#cbd8ff' : '#e8eef9' }}
            onClick={()=>{ try { localStorage.setItem('adminTab', t) } catch {}; setTab(t) }}
          >{t}</button>
        ))}
       </div>

      {error && <div style={{ marginBottom:'8px', color:'#d15b5b' }}>错误：{error}</div>}

      {tab==='graphs' && <ItemList items={graphs} cols={3} />}
      {tab==='strategies' && <ItemList items={strategies} cols={3} />}
      {tab==='runs' && (
        <div>
          <ItemList items={runs} cols={3} />
          <div style={{ marginTop:'8px', display:'flex', alignItems:'center', gap:'8px' }}>
            <input value={selectedRunId} onChange={e=>setSelectedRunId(e.target.value)} placeholder="输入 run_id 订阅事件流" style={{ flex:1, padding:'8px', border:'1px solid var(--panel-border)', borderRadius:4, background:'var(--bg)' }} />
            <button onClick={()=>selectedRunId && setSelectedRunId(selectedRunId)}>订阅</button>
          </div>
        </div>
      )}
      {tab==='events' && <ItemList items={events} cols={2} />}
      {tab==='caches' && <ItemList items={caches} cols={3} />}
      {tab==='recommendations' && <ItemList items={recs} cols={3} />}
      {tab==='ucbs' && <ItemList items={ucbs} cols={3} />}
    </div>
  )
}