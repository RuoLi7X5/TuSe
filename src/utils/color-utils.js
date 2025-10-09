// 颜色工具：RGB<->Lab，KMeans 量化 + 近似色合并（避免灰色误并入绿色）

function rgb2xyz(r,g,b){
  r = r/255; g=g/255; b=b/255;
  r = r>0.04045 ? Math.pow((r+0.055)/1.055,2.4) : r/12.92;
  g = g>0.04045 ? Math.pow((g+0.055)/1.055,2.4) : g/12.92;
  b = b>0.04045 ? Math.pow((b+0.055)/1.055,2.4) : b/12.92;
  const x = (r*0.4124 + g*0.3576 + b*0.1805);
  const y = (r*0.2126 + g*0.7152 + b*0.0722);
  const z = (r*0.0193 + g*0.1192 + b*0.9505);
  return [x*100,y*100,z*100]
}

function xyz2lab(x,y,z){
  const xr=x/95.047, yr=y/100, zr=z/108.883
  const fx = xr>0.008856? Math.pow(xr,1/3) : (7.787*xr)+16/116
  const fy = yr>0.008856? Math.pow(yr,1/3) : (7.787*yr)+16/116
  const fz = zr>0.008856? Math.pow(zr,1/3) : (7.787*zr)+16/116
  return [ (116*fy)-16, 500*(fx-fy), 200*(fy-fz) ]
}

export function rgb2lab(r,g,b){
  const [x,y,z]=rgb2xyz(r,g,b); return xyz2lab(x,y,z)
}

function hex(r,g,b){
  const h = (n)=>n.toString(16).padStart(2,'0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export function distLab(a,b){
  const dl=a[0]-b[0], da=a[1]-b[1], db=a[2]-b[2];
  return Math.sqrt(dl*dl+da*da+db*db)
}

// CIEDE2000 颜色差异（更符合人眼感知）
export function ciede2000(lab1, lab2){
  const [L1,a1,b1]=lab1, [L2,a2,b2]=lab2
  const kL=1, kC=1, kH=1
  const C1=Math.sqrt(a1*a1 + b1*b1)
  const C2=Math.sqrt(a2*a2 + b2*b2)
  const Cbar=(C1+C2)/2
  const G=0.5*(1 - Math.sqrt(Math.pow(Cbar,7)/(Math.pow(Cbar,7)+Math.pow(25,7))))
  const a1p=(1+G)*a1
  const a2p=(1+G)*a2
  const C1p=Math.sqrt(a1p*a1p + b1*b1)
  const C2p=Math.sqrt(a2p*a2p + b2*b2)
  const h1p=Math.atan2(b1,a1p) * 180/Math.PI + (Math.atan2(b1,a1p)<0?360:0)
  const h2p=Math.atan2(b2,a2p) * 180/Math.PI + (Math.atan2(b2,a2p)<0?360:0)
  const dLp=L2-L1
  const dCp=C2p-C1p
  let dhp=h2p-h1p
  if (dhp>180) dhp-=360
  if (dhp<-180) dhp+=360
  const dHp=2*Math.sqrt(C1p*C2p)*Math.sin((dhp*Math.PI/180)/2)
  const Lpbar=(L1+L2)/2
  const Cpbar=(C1p+C2p)/2
  let hpbar=h1p+h2p
  if (Math.abs(h1p-h2p)>180) hpbar += (h1p+h2p<360?360:-360)
  hpbar/=2
  const T=1 - 0.17*Math.cos((hpbar-30)*Math.PI/180) + 0.24*Math.cos((2*hpbar)*Math.PI/180)
           + 0.32*Math.cos((3*hpbar+6)*Math.PI/180) - 0.20*Math.cos((4*hpbar-63)*Math.PI/180)
  const dTheta=30*Math.exp(-Math.pow((hpbar-275)/25,2))
  const Rc=2*Math.sqrt(Math.pow(Cpbar,7)/(Math.pow(Cpbar,7)+Math.pow(25,7)))
  const Sl=1 + (0.015*Math.pow(Lpbar-50,2))/Math.sqrt(20+Math.pow(Lpbar-50,2))
  const Sc=1 + 0.045*Cpbar
  const Sh=1 + 0.015*Cpbar*T
  const Rt = -Rc*Math.sin(2*dTheta*Math.PI/180)
  const dE = Math.sqrt(
    Math.pow(dLp/(kL*Sl),2) + Math.pow(dCp/(kC*Sc),2) + Math.pow(dHp/(kH*Sh),2) + Rt*(dCp/(kC*Sc))*(dHp/(kH*Sh))
  )
  return dE
}

export function labChroma(lab){
  const a=lab[1], b=lab[2];
  return Math.sqrt(a*a + b*b)
}

export function isGreyLab(lab, th=12){
  return labChroma(lab) < th
}

function isWarmLab(lab, aTh=6, bTh=8){
  return lab[1] > aTh || lab[2] > bTh
}

function classifyPaletteLabs(palette, greyChromaTh=8){
  return palette.map(p=>{
    const pr=parseInt(p.slice(1,3),16)
    const pg=parseInt(p.slice(3,5),16)
    const pb=parseInt(p.slice(5,7),16)
    const lab = rgb2lab(pr,pg,pb)
    return { hex:p, lab, isGrey: isGreyLab(lab, greyChromaTh) }
  })
}

function hueAngle(lab){
  // 返回在 a-b 平面的色相角（弧度）
  return Math.atan2(lab[2], lab[1])
}

function hueDistDeg(lab1, lab2){
  // 计算色相角差（度），用于限制不同色相的聚类合并
  let d = Math.abs(hueAngle(lab1) - hueAngle(lab2))
  if (d > Math.PI) d = 2*Math.PI - d
  return d * 180 / Math.PI
}

function kmeans(pixels, K=8, iter=6){
  // init
  const centers=[]
  const step = Math.max(1, Math.floor(pixels.length/K))
  for(let i=0;i<K;i++) centers.push(pixels[i*step])
  let labels = new Array(pixels.length).fill(0)
  for(let t=0;t<iter;t++){
    // assign
    for(let i=0;i<pixels.length;i++){
      let best=0, bd=1e9
      for(let k=0;k<centers.length;k++){
        const d = distLab(pixels[i].lab, centers[k].lab)
        if(d<bd){ bd=d; best=k }
      }
      labels[i]=best
    }
    // update
    const sums=new Array(centers.length).fill(0).map(()=>({l:0,a:0,b:0,count:0}))
    for(let i=0;i<pixels.length;i++){
      const lab=pixels[i].lab, k=labels[i]
      sums[k].l+=lab[0]; sums[k].a+=lab[1]; sums[k].b+=lab[2]; sums[k].count++
    }
    for(let k=0;k<centers.length;k++){
      if(sums[k].count>0){
        const lab=[sums[k].l/sums[k].count, sums[k].a/sums[k].count, sums[k].b/sums[k].count]
        centers[k]={ lab }
      }
    }
  }
  return centers
}

function mergeCenters(centers, th=10){
  // 更保守的合并策略：
  // 1) 降低 Lab 距离阈值（12 -> 10），减少跨色相合并概率
  // 2) 不合并灰色（低饱和度）与有色中心
  // 3) 对有色中心，若色相角差超过阈值则不合并
  const GREY_CHROMA_TH = 12
  const HUE_MERGE_MAX_DEG = 35
  const used=new Array(centers.length).fill(false)
  const out=[]
  for(let i=0;i<centers.length;i++){
    if(used[i]) continue
    let acc={l:centers[i].lab[0],a:centers[i].lab[1],b:centers[i].lab[2],n:1}
    used[i]=true
    for(let j=i+1;j<centers.length;j++){
      if(used[j]) continue
      const li=centers[i].lab, lj=centers[j].lab
      const d = distLab(li, lj)
      if(d<=th){
        const gi = isGreyLab(li, GREY_CHROMA_TH)
        const gj = isGreyLab(lj, GREY_CHROMA_TH)
        if(gi && gj){
          // 两个都是灰色，可以合并
          acc.l+=lj[0]; acc.a+=lj[1]; acc.b+=lj[2]; acc.n++
          used[j]=true
        } else if (!gi && !gj) {
          // 都是有色，色相角差小才合并
          if(hueDistDeg(li, lj) <= HUE_MERGE_MAX_DEG){
            acc.l+=lj[0]; acc.a+=lj[1]; acc.b+=lj[2]; acc.n++
            used[j]=true
          }
        } else {
          // 一个灰一个有色：不合并，避免灰色被吞并
        }
      }
    }
    out.push({ lab:[acc.l/acc.n, acc.a/acc.n, acc.b/acc.n] })
  }
  return out
}

function lab2rgb(L,a,b){
  // inverse of rgb2lab (approx via xyz)
  const fy=(L+16)/116, fx=a/500+fy, fz=fy-b/200
  const xr=Math.pow(fx,3)>0.008856? Math.pow(fx,3) : (fx-16/116)/7.787
  const yr=L>8? Math.pow(fy,3) : L/903.3
  const zr=Math.pow(fz,3)>0.008856? Math.pow(fz,3) : (fz-16/116)/7.787
  let x=xr*95.047, y=yr*100, z=zr*108.883
  x/=100; y/=100; z/=100
  let r = x*3.2406 + y*-1.5372 + z*-0.4986
  let g = x*-0.9689 + y*1.8758 + z*0.0415
  let b2 = x*0.0557 + y*-0.2040 + z*1.0570
  const comp=(c)=>{
    c = c<=0.0031308? 12.92*c : 1.055*Math.pow(c,1/2.4)-0.055
    return Math.max(0, Math.min(255, Math.round(c*255)))
  }
  return [comp(r), comp(g), comp(b2)]
}

export async function quantizeImage(bitmap){
  const canvas=document.createElement('canvas')
  canvas.width=bitmap.width; canvas.height=bitmap.height
  const ctx=canvas.getContext('2d')
  ctx.drawImage(bitmap,0,0)
  const img=ctx.getImageData(0,0,canvas.width,canvas.height)
  const data=img.data
  const stride=4
  const samples=[]
  for(let y=0;y<img.height;y+=stride){
    for(let x=0;x<img.width;x+=stride){
      const i=(y*img.width+x)*4
      const r=data[i], g=data[i+1], b=data[i+2]
      samples.push({ rgb:[r,g,b], lab: rgb2lab(r,g,b) })
    }
  }
  // 适度提高 K 的上限，避免灰色被压缩掉
  const K=Math.min(10, Math.max(3, Math.round(Math.sqrt(samples.length/800))))
  let centers=kmeans(samples, K, 6)
  centers=mergeCenters(centers, 10)
  const palette=centers.map(c=>{
    const [r,g,b]=lab2rgb(c.lab[0],c.lab[1],c.lab[2])
    return hex(r,g,b)
  })
  return { palette }
}

// 基于 Lab 的调色板近邻，并对暖色相（b*>5）相对灰色增加轻微惩罚，降低米黄误判为灰色的概率。
const TUNING = {
  GREY_CHROMA_PIX_TH: 9,
  GREY_PALETTE_CHROMA_TH: 8,
  RED_BIAS_A_TH: 6,
  YELLOW_BIAS_B_TH: 8,
  GREY_PENALTY_BASE: 4,
  WARM_MARGIN: 2.0,
  STRONG_B_TH: 12,
}

export function setColorTuning(partial){
  Object.assign(TUNING, partial || {})
}

export function getColorTuning(){
  return { ...TUNING }
}

export function nearestPalette(hexColor, palette){
  const r=parseInt(hexColor.slice(1,3),16)
  const g=parseInt(hexColor.slice(3,5),16)
  const b=parseInt(hexColor.slice(5,7),16)
  const lab=rgb2lab(r,g,b)
  const {
    GREY_CHROMA_PIX_TH,
    GREY_PALETTE_CHROMA_TH,
    RED_BIAS_A_TH,
    YELLOW_BIAS_B_TH,
    GREY_PENALTY_BASE,
    WARM_MARGIN,
    STRONG_B_TH,
  } = TUNING

  const paletteLabs = classifyPaletteLabs(palette, GREY_PALETTE_CHROMA_TH)

  const isPixGrey = isGreyLab(lab, GREY_CHROMA_PIX_TH)
  const candidates = isPixGrey ? paletteLabs.filter(pl=>isGreyLab(pl.lab, GREY_CHROMA_PIX_TH+4)) : paletteLabs
  const arr = candidates.length>0 ? candidates : paletteLabs

  let best=arr[0].hex, bd=1e9
  let second=arr[0].hex, sd=1e9
  let bestGreyHex=null, bestGreyDist=1e9
  let bestColorHex=null, bestColorDist=1e9
  for(const pl of arr){
    let d=ciede2000(lab, pl.lab)
    // 暖色对灰色的惩罚：a*或b*明显偏暖时提高灰色距离
    const plIsGrey = pl.isGrey
    if(plIsGrey && (lab[1] > RED_BIAS_A_TH || lab[2] > YELLOW_BIAS_B_TH)){
      const warm = Math.max(0, lab[1]-RED_BIAS_A_TH) + Math.max(0, lab[2]-YELLOW_BIAS_B_TH)
      d += GREY_PENALTY_BASE + 0.25*warm
    }
    if(plIsGrey){
      if(d < bestGreyDist){ bestGreyDist = d; bestGreyHex = pl.hex }
    } else {
      if(d < bestColorDist){ bestColorDist = d; bestColorHex = pl.hex }
    }
    if(d<bd){ sd=bd; second=best; bd=d; best=pl.hex }
    else if(d<sd){ sd=d; second=pl.hex }
  }
  // Tie-break：若最佳为灰且像素偏暖，且与次优差距很小，选择非灰的次优
  const bestIsGrey = paletteLabs.find(pl=>pl.hex===best)?.isGrey
  const secondIsGrey = paletteLabs.find(pl=>pl.hex===second)?.isGrey
  const isWarm = isWarmLab(lab, RED_BIAS_A_TH, YELLOW_BIAS_B_TH)
  const MARGIN = WARM_MARGIN
  if(isWarm){
    // 若存在非灰最佳且与灰的差距很小，选择非灰
    if(bestColorHex && bestGreyHex && bestColorDist - bestGreyDist <= MARGIN){
      return bestColorHex
    }
    // 强暖像素：b* 很高时，直接倾向非灰
    if(lab[2] >= STRONG_B_TH && bestColorHex){
      return bestColorHex
    }
    // 若当前最佳是灰，且次优为非灰且差距很小，选择次优
    if(bestIsGrey && !secondIsGrey && sd - bd < MARGIN){
      return second
    }
  }
  return best
}

// 接受 Lab 直接近邻，用于多点采样后的加权平均映射
export function nearestPaletteFromLab(lab, palette){
  const {
    GREY_PALETTE_CHROMA_TH,
    RED_BIAS_A_TH,
    YELLOW_BIAS_B_TH,
    GREY_PENALTY_BASE,
    WARM_MARGIN,
    STRONG_B_TH,
  } = TUNING
  const paletteLabs = classifyPaletteLabs(palette, GREY_PALETTE_CHROMA_TH)
  let best=paletteLabs[0].hex, bd=1e9
  let second=paletteLabs[0].hex, sd=1e9
  let bestGreyHex=null, bestGreyDist=1e9
  let bestColorHex=null, bestColorDist=1e9
  for(const pl of paletteLabs){
    let d=ciede2000(lab, pl.lab)
    const plIsGrey = pl.isGrey
    if(plIsGrey && (lab[1] > RED_BIAS_A_TH || lab[2] > YELLOW_BIAS_B_TH)){
      const warm = Math.max(0, lab[1]-RED_BIAS_A_TH) + Math.max(0, lab[2]-YELLOW_BIAS_B_TH)
      d += GREY_PENALTY_BASE + 0.25*warm
    }
    if(plIsGrey){
      if(d < bestGreyDist){ bestGreyDist = d; bestGreyHex = pl.hex }
    } else {
      if(d < bestColorDist){ bestColorDist = d; bestColorHex = pl.hex }
    }
    if(d<bd){ sd=bd; second=best; bd=d; best=pl.hex }
    else if(d<sd){ sd=d; second=pl.hex }
  }
  const bestIsGrey = paletteLabs.find(pl=>pl.hex===best)?.isGrey
  const secondIsGrey = paletteLabs.find(pl=>pl.hex===second)?.isGrey
  const isWarm = isWarmLab(lab, RED_BIAS_A_TH, YELLOW_BIAS_B_TH)
  const MARGIN = WARM_MARGIN
  if(isWarm){
    if(bestColorHex && bestGreyHex && bestColorDist - bestGreyDist <= MARGIN){
      return bestColorHex
    }
    if(lab[2] >= STRONG_B_TH && bestColorHex){
      return bestColorHex
    }
    if(bestIsGrey && !secondIsGrey && sd - bd < MARGIN){
      return second
    }
  }
  return best
}