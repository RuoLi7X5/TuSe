
// 简单的 IndexedDB 封装，用于存储题目解
const DB_NAME = 'SolverCacheDB';
const STORE_NAME = 'solutions';
const DB_VERSION = 2;

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                try { store.createIndex('pending', 'pending', { unique: false }); } catch {}
            } else {
                try {
                    const store = request.transaction.objectStore(STORE_NAME);
                    if (!store.indexNames.contains('pending')) store.createIndex('pending', 'pending', { unique: false });
                } catch {}
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error('IndexedDB open error:', event.target.error);
            reject(event.target.error);
        };
    });
    return dbPromise;
}

// 复用 telemetry.js 中的 djb2 算法
function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) + str.charCodeAt(i);
        h |= 0;
    }
    return (h >>> 0).toString(16);
}

// 生成题目指纹
export function generateProblemHash(triangles, adj) {
    const colorStr = triangles.map(t => t.color).join('');
    // 简单特征签名：颜色序列 + 节点数 + 边数摘要
    const raw = `${adj.length}|${colorStr}`;
    return djb2(raw);
}

async function saveCachedSolutionLocal(hash, solution) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(hash);
            getReq.onsuccess = () => {
                const prev = getReq.result;
                const prevMin = prev?.solution?.minSteps;
                const nextMin = solution?.minSteps;
                // 仅当更短（或无旧值）才覆盖，避免“更长解”覆盖更短解
                const shouldWrite = (prev == null)
                    || (!Number.isFinite(prevMin) && Number.isFinite(nextMin))
                    || (Number.isFinite(prevMin) && Number.isFinite(nextMin) && nextMin < prevMin);
                if (!shouldWrite) return resolve(true);
                // solutionMeta 用于“只返回合格解”的严格筛选（旧记录无该字段将被视为不可直接命中）
                const solutionMeta = solution?.solutionMeta || prev?.solutionMeta || null
                const req = store.put({ ...(prev||{}), id: hash, solution, solutionMeta, timestamp: Date.now(), pending: false, pendingPayload: null, lastError: null });
                req.onsuccess = () => resolve(true);
                req.onerror = () => resolve(false);
            };
            getReq.onerror = () => resolve(false);
        });
    } catch (e) {
        console.warn('Cache write failed', e);
        return false;
    }
}

function getApiBase() {
    try {
        const base = (typeof window !== 'undefined' && window.SOLVER_FLAGS?.serverBaseUrl) ? String(window.SOLVER_FLAGS.serverBaseUrl) : '';
        return base || '';
    } catch { return ''; }
}

async function markPendingUpload(hash, payload, errMsg) {
    try {
        const db = await openDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(hash);
            getReq.onsuccess = () => {
                const prev = getReq.result || { id: hash, solution: null, timestamp: Date.now() };
                const next = { ...prev, pending: true, pendingPayload: payload, lastError: errMsg || null, timestamp: Date.now() };
                const putReq = store.put(next);
                putReq.onsuccess = () => resolve(true);
                putReq.onerror = () => resolve(false);
            };
            getReq.onerror = () => resolve(false);
        });
    } catch { return false; }
}

async function clearPendingUpload(hash) {
    try {
        const db = await openDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(hash);
            getReq.onsuccess = () => {
                const prev = getReq.result;
                if (!prev) return resolve(true);
                const next = { ...prev, pending: false, pendingPayload: null, lastError: null, timestamp: Date.now() };
                const putReq = store.put(next);
                putReq.onsuccess = () => resolve(true);
                putReq.onerror = () => resolve(false);
            };
            getReq.onerror = () => resolve(false);
        });
    } catch { return false; }
}

export async function flushPendingSolutions(limit = 20) {
    // 仅在后端可用时补传；成功后删除本地缓存（用户需求：后端可用时不在浏览器保留解）
    const base = getApiBase();
    try {
        const health = await fetch(`${base}/api/health`, { method: 'GET' });
        if (!health.ok) return { ok: false, reason: 'health_not_ok' };
    } catch {
        return { ok: false, reason: 'health_failed' };
    }
    let uploaded = 0;
    try {
        const db = await openDB();
        await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const idx = store.index('pending');
            const req = idx.openCursor(IDBKeyRange.only(true));
            req.onsuccess = async () => {
                const cursor = req.result;
                if (!cursor || uploaded >= limit) return resolve();
                const rec = cursor.value;
                const payload = rec?.pendingPayload;
                if (!payload || !rec?.id) {
                    cursor.continue();
                    return;
                }
                try {
                    const res = await fetch(`${base}/api/cache/path`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    if (res.ok) {
                        // 上传成功：删除本地记录（含 pendingPayload/solution）
                        await deleteCachedSolutionLocal(rec.id);
                        uploaded++;
                    } else {
                        await markPendingUpload(rec.id, payload, `HTTP ${res.status}`);
                    }
                } catch (e) {
                    await markPendingUpload(rec.id, payload, String(e?.message || e));
                }
                cursor.continue();
            };
            req.onerror = () => resolve();
        });
    } catch {
        return { ok: false, reason: 'idb_failed' };
    }
    return { ok: true, uploaded };
}

let syncTimer = null;
export function startCacheSyncLoop() {
    if (syncTimer) return;
    // 定时尝试补传 pending 解
    syncTimer = setInterval(() => { flushPendingSolutions().catch(() => {}); }, 15000);
}

export async function getCachedSolution(hash) {
    // 1. Try IndexedDB (L1 Cache)
    try {
        const db = await openDB();
        const local = await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(hash);
            
            req.onsuccess = () => {
                const rec = req.result || null
                const sol = rec ? rec.solution : null
                const meta = rec ? rec.solutionMeta : null
                // 只允许“合格解”直接命中：final + unified
                if (!sol) return resolve(null)
                if (!meta || meta.is_unified !== true || meta.quality !== 'final') return resolve(null)
                return resolve({ ...sol, __cacheSource: 'local' })
            };
            req.onerror = () => resolve(null);
        });
        if (local) return local;
    } catch (e) {
        console.warn('Local cache read failed', e);
    }

    // 2. Try Backend API (L2 Cache - MongoDB)
    try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/cache/path?signature=${hash}&only_final=true`);
        if (res.ok) {
            const data = await res.json();
            // 双保险：即使只请求 final，也要在这里再检查一次返回字段
            if (data && data.path && data.is_unified === true && String(data.quality||'final') === 'final') {
                const sol = { 
                    startId: data.start_id, 
                    paths: [data.path], 
                    minSteps: data.min_steps 
                };
                // 用户需求：后端可用时，不把解写回本地缓存；若本地曾有旧记录，则顺手清掉
                deleteCachedSolutionLocal(hash).catch(()=>{});
                return { ...sol, __cacheSource: 'remote' };
            }
        }
    } catch (e) {
        // Silent fail for network errors, just return null
        // console.warn('Remote cache read failed', e);
    }

    return null;
}

export async function deleteCachedSolutionLocal(hash) {
    try {
        const db = await openDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.delete(hash);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    } catch {
        return false;
    }
}

export async function deleteCachedSolutionRemote(hash) {
    try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/cache/path?signature=${hash}`, { method: 'DELETE' });
        return !!res && res.ok;
    } catch {
        return false;
    }
}

export async function deleteCachedSolutionEverywhere(hash) {
    // best-effort: local + remote
    const a = await deleteCachedSolutionLocal(hash);
    const b = await deleteCachedSolutionRemote(hash);
    return a || b;
}

export async function saveCachedSolution(hash, solution) {
    // 仅允许写入合格解（防止不合格解污染缓存）
    if (!solution?.paths?.[0] || solution?.startId == null || !Number.isFinite(solution?.minSteps)) return
    const path0 = solution.paths[0]
    if (!Array.isArray(path0) || path0.length === 0) return
    if (solution.minSteps !== path0.length) return
    const sol2 = { ...solution, solutionMeta: { is_unified: true, quality: 'final' } }
    // 用户需求：优先写后端；成功则清理本地；失败才落本地并标记 pending
    try {
        const payload = {
            graph_signature: hash,
            path: sol2.paths[0], // already checked
            min_steps: sol2.minSteps,
            start_id: sol2.startId,
            is_unified: true,
            quality: 'final'
        };
        const base = getApiBase();
        const r = await fetch(`${base}/api/cache/path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        if (r && r.ok) {
            // 后端写入成功：删除本地缓存（如果存在）
            deleteCachedSolutionLocal(hash).catch(()=>{});
            return
        }
        // HTTP 非 2xx：落本地并标记 pending，等待后续补传
        await saveCachedSolutionLocal(hash, sol2)
        await markPendingUpload(hash, payload, r ? `HTTP ${r.status}` : 'no_response')
    } catch(e) {
        // 网络/后端不可用：落本地并标记 pending
        try {
            const payload = {
                graph_signature: hash,
                path: sol2.paths[0],
                min_steps: sol2.minSteps,
                start_id: sol2.startId,
                is_unified: true,
                quality: 'final'
            }
            await saveCachedSolutionLocal(hash, sol2)
            await markPendingUpload(hash, payload, String(e?.message||e))
        } catch {}
    }
}

// 生成最小题目数据（用于后端入库/离线补传）
export function makePuzzlePayload(triangles, palette) {
    try {
        const tris = Array.isArray(triangles) ? triangles : [];
        return {
            palette: Array.isArray(palette) ? palette.slice() : [],
            triangles: tris.map(t => ({ id: t.id, color: t.color, neighbors: Array.isArray(t.neighbors) ? t.neighbors : [] })),
        };
    } catch {
        return { palette: Array.isArray(palette) ? palette.slice() : [], triangles: [] };
    }
}

// 带题目数据版本（不破坏旧调用）
export async function saveCachedSolutionWithPuzzle(hash, solution, puzzle, flags) {
    // 仅允许写入合格解（防止不合格解污染缓存）
    if (!solution?.paths?.[0] || solution?.startId == null || !Number.isFinite(solution?.minSteps)) return
    const path0 = solution.paths[0]
    if (!Array.isArray(path0) || path0.length === 0) return
    if (solution.minSteps !== path0.length) return
    const sol2 = { ...solution, solutionMeta: { is_unified: true, quality: 'final' } }
    try {
        const payload = {
            graph_signature: hash,
            path: sol2.paths[0],
            min_steps: sol2.minSteps,
            start_id: sol2.startId,
            is_unified: true,
            quality: 'final',
            puzzle,
            flags: (flags && typeof flags === 'object') ? flags : undefined,
        };
        const base = getApiBase();
        const r = await fetch(`${base}/api/cache/path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        if (r && r.ok) {
            // 后端写入成功：删除本地缓存（如果存在）
            deleteCachedSolutionLocal(hash).catch(()=>{});
            return
        }
        // HTTP 非 2xx：落本地并标记 pending（离线补传）
        await saveCachedSolutionLocal(hash, sol2)
        await markPendingUpload(hash, payload, r ? `HTTP ${r.status}` : 'no_response')
    } catch (e) {
        // 网络/后端不可用：落本地并标记 pending
        try {
            const payload = {
                graph_signature: hash,
                path: sol2.paths[0],
                min_steps: sol2.minSteps,
                start_id: sol2.startId,
                is_unified: true,
                quality: 'final',
                puzzle,
                flags: (flags && typeof flags === 'object') ? flags : undefined,
            }
            await saveCachedSolutionLocal(hash, sol2)
            await markPendingUpload(hash, payload, String(e?.message||e))
        } catch {}
    }
}

// 清空本地缓存（IndexedDB）：用于调试
export async function clearAllCachedSolutionsLocal() {
    try {
        const db = await openDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const cntReq = store.count();
            cntReq.onsuccess = () => {
                const count = Number(cntReq.result || 0);
                const clrReq = store.clear();
                clrReq.onsuccess = () => resolve({ ok: true, deleted: count });
                clrReq.onerror = () => resolve({ ok: false, deleted: 0 });
            };
            cntReq.onerror = () => {
                const clrReq = store.clear();
                clrReq.onsuccess = () => resolve({ ok: true, deleted: null });
                clrReq.onerror = () => resolve({ ok: false, deleted: 0 });
            };
        });
    } catch {
        return { ok: false, deleted: 0 };
    }
}
