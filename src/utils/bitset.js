// Lightweight bitset utilities for representing regions or per-color occupancy.
// Uses Uint32Array words with 32 bits per word.

export function bitsetAlloc(nBits){
  const nWords = Math.max(1, Math.ceil(nBits / 32))
  return new Uint32Array(nWords)
}

export function bitsetClone(bs){
  const out = new Uint32Array(bs.length)
  out.set(bs)
  return out
}

export function bitsetSet(bs, idx){
  const w = idx >>> 5
  const b = idx & 31
  bs[w] |= (1 << b)
}

export function bitsetClear(bs, idx){
  const w = idx >>> 5
  const b = idx & 31
  bs[w] &= ~(1 << b)
}

export function bitsetHas(bs, idx){
  const w = idx >>> 5
  const b = idx & 31
  return (bs[w] & (1 << b)) !== 0
}

export function bitsetFromIds(nBits, ids, idToIndex){
  const bs = bitsetAlloc(nBits)
  for(const id of ids){ const ii = idToIndex.get(id); if(ii!=null) bitsetSet(bs, ii) }
  return bs
}

export function bitsetOr(dst, src){
  for(let i=0;i<dst.length;i++) dst[i] |= src[i] || 0
  return dst
}

export function bitsetAnd(dst, src){
  for(let i=0;i<dst.length;i++) dst[i] &= src[i] || 0
  return dst
}

export function bitsetCount(bs){
  let c=0
  for(let i=0;i<bs.length;i++){
    let x = bs[i] >>> 0
    // builtin popcount for 32-bit via bit hacks
    x = x - ((x >>> 1) & 0x55555555)
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
    c += (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24
  }
  return c
}

export function bitsetToIds(bs, triangles){
  const out=[]
  for(let i=0;i<triangles.length;i++){ if(bitsetHas(bs, i)) out.push(triangles[i].id) }
  return out
}