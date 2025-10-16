// Simple UCB1 Bandit for color prioritization with localStorage persistence per graph signature
import { makeGraphSignature, getUCBStats, putUCBStats } from './telemetry'

export class UCBColorPrioritizer {
  constructor(palette, key){
    this.palette = Array.isArray(palette) ? [...palette] : []
    this.counts = new Map()
    this.rewards = new Map()
    this.totalPulls = 0
    this.key = key || this._computeKey()
    for(const c of this.palette){ this.counts.set(c, 0); this.rewards.set(c, 0) }
    this._load()
  }
  _computeKey(){
    try {
      if (typeof window !== 'undefined'){
        const tris = window.__CURRENT_TRIANGLES__ || []
        const pal = window.__CURRENT_PALETTE__ || this.palette || []
        const sig = makeGraphSignature(tris, pal)
        if (sig) return `ucb:${sig}`
      }
    } catch {}
    return 'ucb:global'
  }
  _load(){
    try {
      if (typeof window === 'undefined') return
      const raw = localStorage.getItem(this.key)
      if (!raw) return
      const data = JSON.parse(raw)
      const arrCounts = Array.isArray(data?.counts) ? data.counts : []
      const arrRewards = Array.isArray(data?.rewards) ? data.rewards : []
      const setPalette = new Set(this.palette)
      for(const [c, n] of arrCounts){ if(setPalette.has(c)) this.counts.set(c, Number(n)||0) }
      for(const [c, r] of arrRewards){ if(setPalette.has(c)) this.rewards.set(c, Number(r)||0) }
      this.totalPulls = Number(data?.totalPulls)||0
    } catch {}
    // Merge remote aggregated stats if telemetry is enabled
    try {
      if (typeof window !== 'undefined' && window.SOLVER_FLAGS?.enableTelemetry) {
        const sig = (this.key||'').replace(/^ucb:/,'')
        if (sig) {
          getUCBStats(sig).then(remote=>{
            if (!remote) return
            const setPalette = new Set(this.palette)
            const countsObj = remote.counts || {}
            const rewardsObj = remote.rewards || {}
            for(const c of Object.keys(countsObj)){ if(setPalette.has(c)) this.counts.set(c, (this.counts.get(c)||0) + (Number(countsObj[c])||0)) }
            for(const c of Object.keys(rewardsObj)){ if(setPalette.has(c)) this.rewards.set(c, (this.rewards.get(c)||0) + (Number(rewardsObj[c])||0)) }
            const tp = Number(remote.totalPulls)||0
            if (tp>0) this.totalPulls = Math.max(this.totalPulls, tp)
          }).catch(()=>{})
        }
      }
    } catch {}
  }
  _save(){
    try {
      if (typeof window === 'undefined') return
      const payload = {
        counts: Array.from(this.counts.entries()),
        rewards: Array.from(this.rewards.entries()),
        totalPulls: this.totalPulls,
      }
      localStorage.setItem(this.key, JSON.stringify(payload))
    } catch {}
    // Debounced upload to central aggregator when telemetry enabled
    try {
      if (typeof window !== 'undefined' && window.SOLVER_FLAGS?.enableTelemetry) {
        clearTimeout(this._uploadTimer)
        this._uploadTimer = setTimeout(()=>{
          try {
            const sig = (this.key||'').replace(/^ucb:/,'')
            const countsObj = {}; for(const [c,n] of this.counts.entries()){ countsObj[c] = Number(n)||0 }
            const rewardsObj = {}; for(const [c,r] of this.rewards.entries()){ rewardsObj[c] = Number(r)||0 }
            putUCBStats(sig, { counts: countsObj, rewards: rewardsObj, totalPulls: this.totalPulls })
          } catch {}
        }, 1500)
      }
    } catch {}
  }
  clear(){
    try { if (typeof window !== 'undefined') localStorage.removeItem(this.key) } catch {}
    for(const c of this.palette){ this.counts.set(c, 0); this.rewards.set(c, 0) }
    this.totalPulls = 0
  }
  ucb(color){
    const n = this.counts.get(color) || 0
    const r = this.rewards.get(color) || 0
    if (n <= 0) return 1.0
    const avg = r / Math.max(1, n)
    return avg + Math.sqrt((2 * Math.log(Math.max(2, this.totalPulls))) / n)
  }
  record(color, reward){
    if (!this.counts.has(color)) this.counts.set(color, 0)
    if (!this.rewards.has(color)) this.rewards.set(color, 0)
    const n = (this.counts.get(color) || 0) + 1
    const r = (this.rewards.get(color) || 0) + (Number.isFinite(reward) ? reward : 0)
    this.counts.set(color, n); this.rewards.set(color, r)
    this.totalPulls += 1
    this._save()
  }
  rank(colors){
    const arr = Array.from(colors).map(c=>({ c, score: this.ucb(c) }))
    arr.sort((a,b)=> b.score - a.score)
    return arr.map(x=>x.c)
  }
}