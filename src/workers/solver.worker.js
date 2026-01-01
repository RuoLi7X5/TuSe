
import init, { Solver } from '../wasm/solver_wasm.js';

let solver = null;
let idToIndex = new Map();

self.onmessage = async (e) => {
    const { type, payload, id } = e.data;
    
    try {
        if (type === 'init') {
            // payload: { triangles, palette }
            await init();
            
            const { triangles, palette } = payload;
            const numNodes = triangles.length;
            
            solver = new Solver(numNodes, palette);
            idToIndex.clear();
            
            // Build index map and populate solver
            triangles.forEach((t, i) => {
                idToIndex.set(t.id, i);
            });
            
            triangles.forEach((t, i) => {
                // Convert neighbor IDs to indices
                const neighborIndices = t.neighbors
                    .map(nid => idToIndex.get(nid))
                    .filter(idx => idx !== undefined);
                
                solver.set_node(i, t.color, new Uint32Array(neighborIndices));
            });
            
            self.postMessage({ type: 'init_done', id });
        } 
        else if (type === 'solve') {
            // payload: { startId, maxDepth }
            if (!solver) throw new Error('Solver not initialized');
            
            const { startId, maxDepth } = payload;
            const startIdx = idToIndex.get(startId);
            
            if (startIdx === undefined) {
                throw new Error(`Invalid startId: ${startId}`);
            }
            
            const result = solver.solve(startIdx, maxDepth || 60);
            self.postMessage({ type: 'solve_done', result, id });
        }
    } catch (err) {
        console.error('Worker Error:', err);
        self.postMessage({ type: 'error', error: err.message, id });
    }
};
