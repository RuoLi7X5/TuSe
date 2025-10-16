// Simple pluggable heuristics registry for strict solvers.
// Heuristic signature: (env, colors, regionSet) => number
// env may include { triangles, idToIndex, neighbors, startId }
import { estimatePDB, hasPDB, listPDBKeys } from './pdb'

const REG = new Map()

export function registerHeuristic(name, fn){
  if(typeof name !== 'string' || typeof fn !== 'function') return false
  REG.set(name, fn)
  return true
}

export function getHeuristic(name){
  if(!name) return null
  const cur = REG.get(name)
  if (cur) return cur
  // Lazy register for PDB-based heuristics: names like 'pdb_6x6_max' or alias 'pdb6x6_max'
  try {
    if (name === 'pdb6x6_max') {
      const key = 'pdb_6x6'
      if (hasPDB(key)) {
        const fn = (env, colors, regionSet)=>{ try { return estimatePDB(key, env, colors, regionSet) || 0 } catch { return 0 } }
        REG.set(name, fn)
        return fn
      }
    }
    const m = /^pdb_([A-Za-z0-9_]+)_max$/.exec(name)
    if (m) {
      const key = `pdb_${m[1]}`
      if (hasPDB(key)) {
        const fn = (env, colors, regionSet)=>{ try { return estimatePDB(key, env, colors, regionSet) || 0 } catch { return 0 } }
        REG.set(name, fn)
        return fn
      }
    }
    // Layered heuristics: combine strict lower bound with PDB using different aggregations
    // layered_pdb_<key>_max -> returns max(lbStrict, pdb)
    // layered_pdb_<key>_sum_<w> -> returns lbStrict + w * pdb (non-admissible for optimal search if w>0)
    // layered_pdb_<key>_weighted_<ws>_<wp> -> returns ws * lbStrict + wp * pdb (non-admissible unless ws<=1 and wp=0)
    const m2 = /^layered_pdb_([A-Za-z0-9_]+)_max$/.exec(name)
    if (m2) {
      const key = `pdb_${m2[1]}`
      if (hasPDB(key)) {
        const fn = (env, colors, regionSet, lbStrict)=>{
          try { return Math.max(lbStrict||0, estimatePDB(key, env, colors, regionSet) || 0) } catch { return lbStrict||0 }
        }
        fn.isLayered = true
        REG.set(name, fn)
        return fn
      }
    }
    const m3 = /^layered_pdb_([A-Za-z0-9_]+)_sum_([0-9]+(?:\.[0-9]+)?)$/.exec(name)
    if (m3) {
      const key = `pdb_${m3[1]}`
      const w = parseFloat(m3[2])
      if (hasPDB(key)) {
        const fn = (env, colors, regionSet, lbStrict)=>{
          try { return (lbStrict||0) + (w * (estimatePDB(key, env, colors, regionSet) || 0)) } catch { return lbStrict||0 }
        }
        fn.isLayered = true
        REG.set(name, fn)
        return fn
      }
    }
    const m4 = /^layered_pdb_([A-Za-z0-9_]+)_weighted_([0-9]+(?:\.[0-9]+)?)_([0-9]+(?:\.[0-9]+)?)$/.exec(name)
    if (m4) {
      const key = `pdb_${m4[1]}`
      const ws = parseFloat(m4[2])
      const wp = parseFloat(m4[3])
      if (hasPDB(key)) {
        const fn = (env, colors, regionSet, lbStrict)=>{
          try { return (ws * (lbStrict||0)) + (wp * (estimatePDB(key, env, colors, regionSet) || 0)) } catch { return (ws * (lbStrict||0)) }
        }
        fn.isLayered = true
        REG.set(name, fn)
        return fn
      }
    }
  } catch {}
  return null
}

// Built-in registrations (safe defaults). Heuristics should be admissible or used with max-composition.
// PDB 6x6 prototype: returns 0 unless a PDB is loaded for key 'pdb_6x6'.
REG.set('pdb6x6_max', (env, colors, regionSet)=>{
  try {
    return estimatePDB('pdb_6x6', env, colors, regionSet) || 0
  } catch { return 0 }
})

// Enumerate available heuristic names for UI. Includes 'none', registered names, and dynamic PDB names.
export function listHeuristicNames(){
  const out = new Set(['none'])
  for (const k of REG.keys()) out.add(k)
  try {
    const keys = typeof listPDBKeys === 'function' ? listPDBKeys() : []
    for(const key of keys){
      // Key like 'pdb_6x6' -> heuristic name 'pdb_6x6_max'
      if (typeof key === 'string' && key.startsWith('pdb_')){
        out.add(`${key}_max`)
        const suffix = key.slice('pdb_'.length)
        out.add(`layered_pdb_${suffix}_max`)
        out.add(`layered_pdb_${suffix}_sum_0.5`)
        out.add(`layered_pdb_${suffix}_weighted_1.0_0.3`)
      }
    }
  } catch {}
  return Array.from(out)
}