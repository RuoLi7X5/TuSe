
import JsWorker from '../workers/js-solver.worker?worker'
import WasmWorker from '../workers/solver.worker?worker'

const MAX_POOL_SIZE = 4;
const pools = {
    js: [],
    wasm: []
};

export const WorkerPool = {
    acquire(type) {
        const pool = pools[type];
        if (pool.length > 0) {
            return pool.pop();
        }
        // Create new worker if pool empty
        if (type === 'js') return new JsWorker();
        if (type === 'wasm') return new WasmWorker();
        return null;
    },
    
    release(worker, type) {
        if (!worker) return;
        // Clean up event listeners to avoid leaks
        worker.onmessage = null;
        worker.onerror = null;
        
        const pool = pools[type];
        if (pool.length < MAX_POOL_SIZE) {
            pool.push(worker);
        } else {
            worker.terminate();
        }
    }
};
