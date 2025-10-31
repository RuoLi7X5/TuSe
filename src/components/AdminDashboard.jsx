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
  const [scoreStats, setScoreStats] = useState(null)
  const [algoScores, setAlgoScores] = useState([])
  const [moduleAgg, setModuleAgg] = useState([])
  const [adminAgg, setAdminAgg] = useState([])

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

  // 令牌需要在运行期可更新，不能用 useMemo 固定
  const [token, setToken] = useState(() => {
    try { return (typeof window!=='undefined' ? (window.ADMIN_TOKEN || localStorage.getItem('adminToken') || '') : '') } catch { return '' }
  })
  const [pwd, setPwd] = useState('')

  async function getJSON(path, tkn){
    setError('')
    const url = `${serverBase}${path}`
    const useToken = tkn || token
    const headers = useToken ? { Authorization: 'Bearer '+useToken } : {}
    const res = await fetch(url, { headers })
    if(!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  }

  const refresh = async (tkn) => {
    try {
      setLoading(true)
      const [g, s, r, c, rr, u] = await Promise.all([
        getJSON('/api/admin/graphs?limit=50', tkn),
        getJSON('/api/admin/strategies?limit=50', tkn),
        getJSON('/api/admin/runs?limit=50', tkn),
        getJSON('/api/admin/caches?limit=50', tkn),
        getJSON('/api/admin/recommendations?limit=50', tkn),
        getJSON('/api/admin/ucbs?limit=50', tkn),
      ])
      setGraphs(g||[]); setStrategies(s||[]); setRuns(r||[]); setCaches(c||[]); setRecs(rr||[]); setUcbs(u||[])
    } catch(e){ setError(String(e.message||e)) } finally { setLoading(false) }
  }

  // 登录以获取后端内存令牌（服务重启后需要重新登录）
  const loginWithPassword = async () => {
    try {
      if (!pwd) { setError('请输入管理员密码'); return }
      setLoading(true)
      const url = `${serverBase}/api/auth/login?password=${encodeURIComponent(pwd)}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`登录失败：HTTP ${res.status}`)
      const data = await res.json()
      const tk = String(data?.token||'')
      if (!tk) throw new Error('登录失败：未返回令牌')
      setToken(tk)
      try { localStorage.setItem('adminToken', tk) } catch {}
      setPwd('')
      await refresh(tk)
    } catch (e) {
      setError(String(e.message||e))
    } finally { setLoading(false) }
  }
  const logout = () => {
    try { localStorage.removeItem('adminToken') } catch {}
    setToken('')
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
  }, [selectedRunId, token])

  const ItemList = ({ items, cols }) => {
    const data = Array.isArray(items) ? items : []
    const [page, setPage] = useState(1)
    const pageSize = 50
    const columns = useMemo(() => {
      const ks = new Set()
      data.slice(0, 200).forEach(it => {
        Object.keys(it || {}).forEach(k => ks.add(k))
      })
      return Array.from(ks)
    }, [items])

    const pages = Math.max(1, Math.ceil(data.length / pageSize))
    const start = (page - 1) * pageSize
    const rows = data.slice(start, start + pageSize)

    const fmt = (v) => {
      if (v === null || v === undefined) return ''
      if (typeof v === 'object') {
        try {
          const s = JSON.stringify(v)
          return s.length > 200 ? (s.slice(0, 200) + '…') : s
        } catch {
          return String(v)
        }
      }
      return String(v)
    }

    if (!data.length) return <div style={{ color:'#9ab', fontSize:12 }}>暂无数据</div>

    return (
      <div style={{ overflowX:'auto', border:'1px solid var(--panel-border)', borderRadius:6 }}>
        <table style={{ width:'100%', borderCollapse:'collapse', minWidth:800 }}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} style={{ position:'sticky', top:0, background:'#1f2a3b', color:'#cbd3e1', textAlign:'left', padding:'8px', borderBottom:'1px solid #3a4260' }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((it, i) => (
              <tr key={start + i} style={{ background: (start + i) % 2 ? '#243246' : '#202b3d' }}>
                {columns.map((c) => (
                  <td key={c} style={{ padding:'8px', fontSize:'12px', color:'#dfe6f3', verticalAlign:'top', borderBottom:'1px solid #334059' }}>{fmt(it?.[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px' }}>
          <span style={{ fontSize:12, color:'#9ab' }}>第 {page}/{pages} 页，共 {data.length} 条</span>
          <button disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>上一页</button>
          <button disabled={page>=pages} onClick={()=>setPage(p=>Math.min(pages,p+1))}>下一页</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding:'12px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'12px' }}>
        {/* 前台总站入口已移除，不再提供返回链接 */}
        <div style={{ flex:1 }} />
        <button onClick={()=>refresh()} disabled={loading}>{loading? '刷新中…' : '刷新'}</button>
        <input
          type="password"
          value={pwd}
          onChange={e=>setPwd(e.target.value)}
          placeholder="管理员密码"
          style={{ width:140, padding:'6px 8px', background:'var(--bg)', border:'1px solid var(--panel-border)', borderRadius:4 }}
        />
        <button onClick={loginWithPassword} disabled={loading || !pwd} title="输入管理员密码后登录获取令牌">登录</button>
        <span style={{ fontSize:'12px', color:'#93a0b7' }}>后端：{serverBase}</span>
        {token ? (
          <span style={{ fontSize:'12px', color:'#7aa2f7' }}>已认证</span>
        ) : (
          <span style={{ fontSize:'12px', color:'#d15b5b' }}>未认证</span>
        )}
        {token && <button onClick={logout} title="清除本地令牌">退出</button>}
      </div>

       <div style={{ display:'flex', gap:'6px', marginBottom:'12px' }}>
        {['graphs','strategies','runs','events','caches','recommendations','ucbs','scores'].map(t => (
          <button
            key={t}
            className={tab===t? 'primary' : ''}
            style={{ background:'#273245', border:'1px solid #3a4260', color: tab===t ? '#cbd8ff' : '#e8eef9' }}
            onClick={()=>{ try { localStorage.setItem('adminTab', t) } catch {}; setTab(t) }}
          >{t}</button>
        ))}
       </div>

      {error && <div style={{ marginBottom:'8px', color:'#d15b5b' }}>错误：{error}{String(error||'').includes('401')? '（请在右上角输入密码并点击登录）':''}</div>}

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
      {tab==='scores' && (
        <div>
          <div style={{ marginBottom:'8px', display:'flex', alignItems:'center', gap:'8px' }}>
            <input id="scoreSig" placeholder="输入 graph_signature（可选）" style={{ flex:1, padding:'8px', border:'1px solid var(--panel-border)', borderRadius:4, background:'var(--bg)' }} />
            <button onClick={async()=>{
              try {
                setLoading(true); setError('')
                const sig = document.getElementById('scoreSig')?.value?.trim()
                if(!sig) { setError('请先输入 signature'); return }
                const stats = await getJSON(`/api/score/aggregate?signature=${encodeURIComponent(sig)}`)
                const algos = await getJSON(`/api/score/algo?signature=${encodeURIComponent(sig)}`)
                setScoreStats(stats||null); setAlgoScores(algos||[])
              } catch(e){ setError(String(e.message||e)) } finally { setLoading(false) }
            }}>查询旧版统计</button>
            <button onClick={async()=>{
              try {
                setLoading(true); setError('')
                const sig = document.getElementById('scoreSig')?.value?.trim()
                if(!sig) { setError('请先输入 signature'); return }
                const mods = await getJSON(`/api/learn/scores?signature=${encodeURIComponent(sig)}`)
                setModuleAgg(Array.isArray(mods)?mods:[])
              } catch(e){ setError(String(e.message||e)) } finally { setLoading(false) }
            }}>查询模块（按 signature）</button>
            <button onClick={async()=>{
              try {
                setLoading(true); setError('')
                const sig = document.getElementById('scoreSig')?.value?.trim()
                const path = `/api/admin/scores${sig?`?signature=${encodeURIComponent(sig)}`:''}`
                const mods = await getJSON(path)
                setAdminAgg(Array.isArray(mods)?mods:[])
              } catch(e){ setError(String(e.message||e)) } finally { setLoading(false) }
            }} title="需要管理员认证">查询全局模块汇总</button>
          </div>
          {scoreStats && (
            <div style={{ background:'var(--panel)', padding:'8px', border:'1px solid var(--panel-border)', borderRadius:4, marginBottom:'10px' }}>
              <div style={{ fontSize:13, color:'#cbd3e1' }}>Signature: <code>{scoreStats.signature}</code></div>
              <div style={{ display:'flex', gap:'12px', marginTop:'6px', fontSize:12 }}>
                <div>总运行数：{scoreStats.total_runs}</div>
                <div>平均最少步骤：{Math.round(scoreStats.avg_min_steps||0)}</div>
                <div>平均耗时(ms)：{Math.round(scoreStats.avg_time_ms||0)}</div>
                <div>最终统一率：{((scoreStats.final_unified_rate||0)*100).toFixed(1)}%</div>
              </div>
            </div>
          )}
          <ItemList items={algoScores} cols={3} />
          <div style={{ marginTop:'8px', color:'#9ab', fontSize:12 }}>模块聚合（按 signature 查询）：</div>
          <ItemList items={moduleAgg} cols={3} />
          <div style={{ marginTop:'8px', color:'#9ab', fontSize:12 }}>管理员全局模块聚合：</div>
          <ItemList items={adminAgg} cols={3} />
        </div>
      )}
    </div>
  )
}