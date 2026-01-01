
// 简单的 IndexedDB 封装，用于存储题目解
const DB_NAME = 'SolverCacheDB';
const STORE_NAME = 'solutions';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
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
            const req = store.put({ id: hash, solution, timestamp: Date.now() });
            
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    } catch (e) {
        console.warn('Cache write failed', e);
        return false;
    }
}

export async function getCachedSolution(hash) {
    // 1. Try IndexedDB (L1 Cache)
    try {
        const db = await openDB();
        const local = await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(hash);
            
            req.onsuccess = () => resolve(req.result ? req.result.solution : null);
            req.onerror = () => resolve(null);
        });
        if (local) return local;
    } catch (e) {
        console.warn('Local cache read failed', e);
    }

    // 2. Try Backend API (L2 Cache - MongoDB)
    try {
        const res = await fetch(`/api/cache/path?signature=${hash}&only_final=true`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.path) {
                const sol = { 
                    startId: data.start_id, 
                    paths: [data.path], 
                    minSteps: data.min_steps 
                };
                // Async write back to local cache so next time it's faster
                saveCachedSolutionLocal(hash, sol).catch(()=>{});
                return sol;
            }
        }
    } catch (e) {
        // Silent fail for network errors, just return null
        // console.warn('Remote cache read failed', e);
    }

    return null;
}

export async function saveCachedSolution(hash, solution) {
    // 1. Save Local
    await saveCachedSolutionLocal(hash, solution);
    
    // 2. Save Remote (Async)
    try {
        const payload = {
            graph_signature: hash,
            path: solution.paths[0], // Assume the first path is valid
            min_steps: solution.minSteps,
            start_id: solution.startId,
            is_unified: true,
            quality: 'final'
        };
        fetch('/api/cache/path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(e => console.warn('Remote cache write error', e));
    } catch(e) {}
}
