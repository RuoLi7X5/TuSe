
import { attachSolverToWindow } from '../utils/solver.js';

// Attach functions to 'self' (the worker global scope)
attachSolverToWindow();

self.onmessage = async (e) => {
    const { type, payload, id } = e.data;
    try {
        if (type === 'solve') {
            const { triangles, startId, palette, maxBranches, stepLimit, flags } = payload;
            
            // Set flags for this run
            self.SOLVER_FLAGS = flags || {};
            
            // Call the solver
            // Note: Solver_minSteps is now attached to self by attachSolverToWindow
            // Pass workerTimeBudgetMs if provided in flags, otherwise rely on default
            if (flags && flags.workerTimeBudgetMs) {
                // Ensure the solver knows about the budget via flags
                self.SOLVER_FLAGS.workerTimeBudgetMs = flags.workerTimeBudgetMs;
            }
            
            const result = await self.Solver_minSteps(triangles, startId, palette, maxBranches, (p) => {
                // Throttle progress updates if needed
                self.postMessage({ type: 'progress', progress: p, id });
            }, stepLimit);
            
            self.postMessage({ type: 'solve_done', result, id });
        }
    } catch (err) {
        console.error('JS Worker Error:', err);
        self.postMessage({ type: 'error', error: err.message, id });
    }
};
