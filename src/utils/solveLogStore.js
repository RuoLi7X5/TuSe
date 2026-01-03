// 独立的“求解日志”存储：只记录跑出合格解时的日志/策略摘要，用于调试与复盘。
// 注意：该 DB 不会被“清除解缓存（题目+合格解缓存）”按钮清理。

const DB_NAME = 'SolverQualifiedLogDB'
const STORE_NAME = 'qualified_logs'
const DB_VERSION = 1

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        try { store.createIndex('by_time', 'timestamp', { unique: false }) } catch {}
        try { store.createIndex('by_signature', 'graph_signature', { unique: false }) } catch {}
      }
    }
    req.onsuccess = (ev) => resolve(ev.target.result)
    req.onerror = (ev) => reject(ev.target.error)
  })
  return dbPromise
}

export async function saveQualifiedSolveLog(entry) {
  try {
    const db = await openDB()
    const now = Date.now()
    const graphSig = String(entry?.graph_signature || '')
    const id = entry?.id ? String(entry.id) : `${graphSig || 'unknown'}:${now}`
    const rec = {
      id,
      timestamp: Number.isFinite(entry?.timestamp) ? entry.timestamp : now,
      graph_signature: graphSig || null,
      min_steps: Number.isFinite(entry?.min_steps) ? entry.min_steps : null,
      best_start_id: (entry?.best_start_id ?? null),
      winner: entry?.winner || null,          // { workerIndex, group, preferredStartId, strategy, modules }
      flags: entry?.flags || null,            // 可选：记录当时 flags（可裁剪）
      summary: entry?.summary || null,        // 可选：一句话摘要
      lines: Array.isArray(entry?.lines) ? entry.lines.slice(0, 2000) : [], // 防止无限膨胀
    }
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const put = store.put(rec)
      put.onsuccess = () => resolve({ ok: true, id })
      put.onerror = () => resolve({ ok: false, id: null })
    })
  } catch {
    return { ok: false, id: null }
  }
}

export async function listQualifiedSolveLogs(limit = 50) {
  try {
    const db = await openDB()
    const lim = Math.max(1, Math.min(200, Number(limit) || 50))
    return await new Promise((resolve) => {
      const out = []
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      let idx = null
      try { idx = store.index('by_time') } catch { idx = null }
      const req = idx ? idx.openCursor(null, 'prev') : store.openCursor(null, 'prev')
      req.onsuccess = () => {
        const cur = req.result
        if (!cur || out.length >= lim) return resolve(out)
        out.push(cur.value)
        cur.continue()
      }
      req.onerror = () => resolve(out)
    })
  } catch {
    return []
  }
}

export async function getQualifiedSolveLog(id) {
  try {
    const db = await openDB()
    const key = String(id || '')
    if (!key) return null
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function deleteQualifiedSolveLog(id) {
  try {
    const db = await openDB()
    const key = String(id || '')
    if (!key) return { ok: false }
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.delete(key)
      req.onsuccess = () => resolve({ ok: true })
      req.onerror = () => resolve({ ok: false })
    })
  } catch {
    return { ok: false }
  }
}


