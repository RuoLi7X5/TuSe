
// 网格线提取与参数检测核心模块
// 移植自 grid-extraction-tool.html

export function detectGrid(imageData, config = {}) {
  const { width, height, data } = imageData
  const { threshold = 50 } = config

  // 1. 灰度化与 Sobel 边缘检测
  const grayData = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    grayData[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }

  const gradients = new Float32Array(width * height)
  // Gx = [-1 0 1; -2 0 2; -1 0 1]
  // Gy = [-1 -2 -1; 0 0 0; 1 2 1]
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const tl = grayData[(y - 1) * width + (x - 1)]
      const tr = grayData[(y - 1) * width + (x + 1)]
      const ml = grayData[y * width + (x - 1)]
      const mr = grayData[y * width + (x + 1)]
      const bl = grayData[(y + 1) * width + (x - 1)]
      const br = grayData[(y + 1) * width + (x + 1)]
      const tm = grayData[(y - 1) * width + x]
      const bm = grayData[(y + 1) * width + x]

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br
      const gy = -tl - 2 * tm - tr + bl + 2 * bm + br

      const mag = Math.sqrt(gx * gx + gy * gy)
      gradients[idx] = mag > threshold ? mag : 0
    }
  }

  // 2. 自动检测网格模式 (Horizontal vs Vertical)
  const angleSets = {
    horizontal: [90, 30, 150], // Normals for lines at 0, 120, 60
    vertical: [0, 60, 120]     // Normals for lines at 90, 150, 30
  }

  const maxRho = Math.ceil(Math.sqrt(width * width + height * height))
  const numRhos = Math.ceil(2 * maxRho) + 1 // +1 for safety
  const degToRad = Math.PI / 180

  const computeScore = (angles) => {
    const accs = angles.map(() => new Int32Array(numRhos))
    const cs = angles.map(deg => ({ c: Math.cos(deg * degToRad), s: Math.sin(deg * degToRad) }))
    
    // 下采样加速检测
    const step = 2
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = y * width + x
        if (gradients[idx] > threshold) {
          for (let a = 0; a < angles.length; a++) {
            const { c, s } = cs[a]
            const rho = x * c + y * s
            const rhoIdx = Math.round(rho + maxRho)
            if (rhoIdx >= 0 && rhoIdx < numRhos) {
              accs[a][rhoIdx] += gradients[idx]
            }
          }
        }
      }
    }

    let score = 0
    for (let a = 0; a < angles.length; a++) {
      let maxV = 0
      for (let i = 0; i < numRhos; i++) maxV = Math.max(maxV, accs[a][i])
      score += maxV
    }
    return score
  }

  const scoreH = computeScore(angleSets.horizontal)
  const scoreV = computeScore(angleSets.vertical)
  
  const mode = scoreV > scoreH ? 'vertical' : 'horizontal'
  const targetAngles = angleSets[mode]

  // 3. 全分辨率累积投票
  const accumulators = targetAngles.map(() => new Int32Array(numRhos))
  const cosSin = targetAngles.map(deg => ({ c: Math.cos(deg * degToRad), s: Math.sin(deg * degToRad) }))

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (gradients[idx] > 0) {
        for (let a = 0; a < targetAngles.length; a++) {
          const { c, s } = cosSin[a]
          const rho = x * c + y * s
          const rhoIdx = Math.round(rho + maxRho)
          if (rhoIdx >= 0 && rhoIdx < numRhos) {
            accumulators[a][rhoIdx] += gradients[idx]
          }
        }
      }
    }
  }

  // 4. 提取原始峰值
  const anglePeaks = []
  const windowSize = 5
  
  for (let a = 0; a < targetAngles.length; a++) {
    const acc = accumulators[a]
    let maxVote = 0
    for (let i = 0; i < numRhos; i++) maxVote = Math.max(maxVote, acc[i])
    
    // 使用较低阈值以捕获更多数据
    const voteThreshold = maxVote * 0.15
    const currentPeaks = []

    for (let i = windowSize; i < numRhos - windowSize; i++) {
      const val = acc[i]
      if (val > voteThreshold) {
        let isMax = true
        for (let k = 1; k <= windowSize; k++) {
          if (acc[i - k] >= val || acc[i + k] > val) {
            isMax = false
            break
          }
        }
        if (isMax) {
          currentPeaks.push({ rho: i - maxRho, score: val })
        }
      }
    }
    currentPeaks.sort((a, b) => a.rho - b.rho)
    anglePeaks.push(currentPeaks)
  }

  // 5. 分角度计算间距 (Spacing)
  // 改进：优先信任主轴（Index 0），因为它是决定行高的关键，且通常最清晰。
  // 如果混用对角线的间距，在非等边网格下会导致行高计算错误（Drift）。
  const getMedian = (arr) => {
    if (!arr.length) return 0
    const s = arr.slice().sort((a,b)=>a-b)
    const mid = Math.floor(s.length/2)
    if (s.length % 2 === 0) return (s[mid-1] + s[mid]) / 2
    return s[mid]
  }

  const spacingPerAngle = []
  anglePeaks.forEach((peaks, angleIdx) => {
    const diffs = []
    for (let i = 1; i < peaks.length; i++) {
       const d = peaks[i].rho - peaks[i - 1].rho
       if (d > 5 && d < Math.min(width, height) / 2) {
          diffs.push(d)
       }
    }
    if (diffs.length > 0) {
       // 过滤离群值（Outlier Filtering）
       const med = getMedian(diffs)
       // 允许 20% 的偏差，或者至少 2px
       const validDiffs = diffs.filter(d => Math.abs(d - med) < Math.max(2, med * 0.2))
       if (validDiffs.length > 0) {
          const avg = validDiffs.reduce((a,b)=>a+b,0) / validDiffs.length
          spacingPerAngle.push({ angleIdx, spacing: avg, count: validDiffs.length })
       }
    }
  })

  let bestSpacing = 0
  
  // 优先使用主轴（Index 0: Horizontal lines for horizontal mode）
  // 同时也计算 Diagonal Spacing (Index 1/2) 来推导 Side Length
  const primary = spacingPerAngle.find(s => s.angleIdx === 0)
  const diagonals = spacingPerAngle.filter(s => s.angleIdx > 0)
  
  if (primary && primary.count >= 3) {
     bestSpacing = primary.spacing
  } else if (spacingPerAngle.length > 0) {
     // 降级：加权平均
     let sum = 0, total = 0
     spacingPerAngle.forEach(s => { sum += s.spacing * s.count; total += s.count })
     bestSpacing = sum / total
  } else {
     return { success: false, reason: 'No valid line spacing detected' }
  }
  
  // 重要：本项目网格必须由“等边三角形”组成，因此强制采用等边几何关系：
  // bestSpacing = H（高度），Side = H / (sqrt(3)/2)
  
  // 最终使用的 side 和 height
  // 如果 detectedSideFromDiag 存在且与 inferredSide 差异较大 (>5%)，说明是非等边
  // 此时我们应该分别返回 spacing (H) 和 derived side (S)
  
  // 能量密度检查 (尝试 /2, /3)
  if (bestSpacing > 15) {
    const checkDivisorEnergy = (divisor) => {
      const testSpacing = bestSpacing / divisor
      let validAngles = 0
      
      for (let a = 0; a < targetAngles.length; a++) {
        const acc = accumulators[a]
        let bestP = 0, maxE = 0
        for (let p = 0; p < testSpacing; p++) {
          let e = 0
          const sK = Math.ceil((-maxRho - p) / testSpacing)
          const eK = Math.floor((maxRho - p) / testSpacing)
          for (let k = sK; k <= eK; k++) {
            const idx = Math.round(p + k * testSpacing + maxRho)
            if (idx >= 0 && idx < numRhos) e += acc[idx]
          }
          if (e > maxE) { maxE = e; bestP = p }
        }
        
        // Compare average energy
        let parentMaxE = 0
        for (let p = 0; p < bestSpacing; p++) {
          let e = 0
          const sK = Math.ceil((-maxRho - p) / bestSpacing)
          const eK = Math.floor((maxRho - p) / bestSpacing)
          for (let k = sK; k <= eK; k++) {
            const idx = Math.round(p + k * bestSpacing + maxRho)
            if (idx >= 0 && idx < numRhos) e += acc[idx]
          }
          if (e > parentMaxE) parentMaxE = e
        }
        
        const lineCountTest = (2 * maxRho) / testSpacing
        const lineCountParent = (2 * maxRho) / bestSpacing
        const avgE = maxE / lineCountTest
        const parentAvgE = parentMaxE / lineCountParent
        
        // 提高阈值到 0.9，防止过度分割导致网格过密
        if (avgE > 0.9 * parentAvgE) validAngles++
      }
      return validAngles >= 2
    }
    
    if (checkDivisorEnergy(2)) bestSpacing /= 2
    else if (checkDivisorEnergy(3)) bestSpacing /= 3
  }

  if (bestSpacing <= 5) {
    return { success: false, reason: 'Spacing too small or invalid' }
  }

  // 6. 确定每个角度的 Anchor (Best Phase)
  const anchors = []
  for (let a = 0; a < targetAngles.length; a++) {
    const acc = accumulators[a]
    
    // Find raw peak anchor
    let bestRhoIdx = -1
    let maxScore = -1
    for (let i = windowSize; i < numRhos - windowSize; i++) {
      if (acc[i] > maxScore) {
        maxScore = acc[i]
        bestRhoIdx = i
      }
    }
    
    let anchorRho = (bestRhoIdx !== -1) ? (bestRhoIdx - maxRho) : 0
    if (bestRhoIdx === -1) {
       // Fallback to center
       const rad = targetAngles[a] * degToRad
       anchorRho = (width / 2) * Math.cos(rad) + (height / 2) * Math.sin(rad)
    }

    // Fine tune phase
    let bestOffset = 0
    let maxEnergy = -1
    const searchRange = Math.min(10, Math.floor(bestSpacing / 2))
    
    // Check intersection helper
    const intersectsCanvas = (rho) => {
       const rad = targetAngles[a] * degToRad
       const c = Math.cos(rad), s = Math.sin(rad)
       const p1 = 0, p2 = width * c, p3 = height * s, p4 = width * c + height * s
       const minP = Math.min(p1, p2, p3, p4) - 10
       const maxP = Math.max(p1, p2, p3, p4) + 10
       return rho >= minP && rho <= maxP
    }

    for (let offset = -searchRange; offset <= searchRange; offset++) {
      let energy = 0
      let k = 0
      // Forward
      while (true) {
        const r = (anchorRho + offset) + k * bestSpacing
        if (!intersectsCanvas(r)) break
        const idx = Math.round(r + maxRho)
        if (idx >= 0 && idx < numRhos) energy += acc[idx]
        k++
      }
      // Backward
      k = 1
      while (true) {
        const r = (anchorRho + offset) - k * bestSpacing
        if (!intersectsCanvas(r)) break
        const idx = Math.round(r + maxRho)
        if (idx >= 0 && idx < numRhos) energy += acc[idx]
        k++
      }
      if (energy > maxEnergy) {
        maxEnergy = energy
        bestOffset = offset
      }
    }
    anchors.push(anchorRho + bestOffset)
  }

  // 计算每条网格线在画布内的线段（Start/End/Length）
  // 这对于网格对齐和可视化非常重要
  const getGridLineSegment = (angle, rho, w, h) => {
    const rad = angle * Math.PI / 180
    const c = Math.cos(rad), s = Math.sin(rad)
    const pts = []
    // Left x=0: y = rho/s
    if (Math.abs(s)>1e-6) { const y=rho/s; if(y>=0 && y<=h) pts.push({x:0, y}) }
    // Right x=w: y = (rho - w*c)/s
    if (Math.abs(s)>1e-6) { const y=(rho-w*c)/s; if(y>=0 && y<=h) pts.push({x:w, y}) }
    // Top y=0: x = rho/c
    if (Math.abs(c)>1e-6) { const x=rho/c; if(x>=0 && x<=w) pts.push({x, y:0}) }
    // Bottom y=h: x = (rho - h*s)/c
    if (Math.abs(c)>1e-6) { const x=(rho-h*s)/c; if(x>=0 && x<=w) pts.push({x, y:h}) }
    
    // Dedup
    const unique = []
    pts.forEach(p => { if(!unique.some(u => Math.abs(u.x-p.x)<0.1 && Math.abs(u.y-p.y)<0.1)) unique.push(p) })
    
    if (unique.length === 2) {
       const dx = unique[1].x - unique[0].x
       const dy = unique[1].y - unique[0].y
       return { start: unique[0], end: unique[1], length: Math.sqrt(dx*dx + dy*dy) }
    }
    return null
  }

  const gridLines = []
  // Reconstruct lines from anchors and spacing
  // For each angle set
  const maxDim = Math.max(width, height)
  
  // 7. 返回完整的网格规格
  // 对于等边三角形网格，Height (h) = side * sqrt(3) / 2
  // 我们检测到的 bestSpacing 就是这个 h (垂直于网格线的距离)
  // 因此推导出的 side = bestSpacing / (sqrt(3)/2)
  const inferredSide = bestSpacing / (Math.sqrt(3) / 2)
  
  // 最终决策：严格等边
  const finalSide = inferredSide

  targetAngles.forEach((angle, i) => {
     const anchor = anchors[i]
     // Spacing calculation must be consistent with finalSide/bestSpacing decision
     // i=0 is horizontal lines (spacing = bestSpacing)
     // i=1,2 are diagonal lines
     
     // 等边网格：三组平行线的间距一致，均为 bestSpacing（高度）
     const lineSpacing = bestSpacing
     
     // Generate lines range
     // anchor is one line. We expand k in both directions.
     const kRange = Math.ceil(maxDim / lineSpacing) + 2
     for(let k = -kRange; k <= kRange; k++){
        const rho = anchor + k * lineSpacing
        const seg = getGridLineSegment(angle, rho, width, height)
        if (seg) {
           gridLines.push({ ...seg, angle, index: k, type: i===0 ? 'primary' : 'diagonal' })
        }
     }
  })

  // 8. 检测网格线的实际存在区域（Segments）并推断边界
  const activeSegments = []
  
  // 辅助：检查点是否在画布内
  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height
  
  // 遍历每一条生成的候选网格线
  gridLines.forEach(line => {
     // 沿着线段进行扫描，寻找有边缘强度的起始和结束点
     // line.start, line.end
     const dx = line.end.x - line.start.x
     const dy = line.end.y - line.start.y
     const len = Math.sqrt(dx*dx + dy*dy)
     if(len < 10) return
     
     const ux = dx / len
     const uy = dy / len
     
     let firstActive = -1
     let lastActive = -1
     
     // 扫描步长
     for(let t=0; t<len; t+=2){
        const x = Math.round(line.start.x + ux * t)
        const y = Math.round(line.start.y + uy * t)
        if(inBounds(x,y)){
           const idx = y * width + x
           // 检查该点附近是否有强边缘 (gradients[idx] > threshold)
           // 放宽一点范围，检查 3x3 邻域
           let hasEdge = false
           for(let dy=-1; dy<=1; dy++){
              for(let dx=-1; dx<=1; dx++){
                 const ni = (y+dy)*width + (x+dx)
                 if(ni>=0 && ni<gradients.length && gradients[ni] > threshold * 0.5){
                    hasEdge = true; break
                 }
              }
              if(hasEdge) break
           }
           
           if(hasEdge){
              if(firstActive === -1) firstActive = t
              lastActive = t
           }
        }
     }
     
     if(firstActive !== -1 && (lastActive - firstActive) > 20){
        // 找到有效线段
        activeSegments.push({
           start: { x: line.start.x + ux * firstActive, y: line.start.y + uy * firstActive },
           end: { x: line.start.x + ux * lastActive, y: line.start.y + uy * lastActive },
           angle: line.angle,
           type: line.type
        })
     }
  })
  
  // 9. 基于有效线段的端点推断边界 (Bounding Box)
  // 收集所有端点
  const endPoints = []
  activeSegments.forEach(s => {
     endPoints.push(s.start)
     endPoints.push(s.end)
  })
  
  let bounds = null
  if(endPoints.length > 4){
     // 简单的直方图/统计法找边界
     // 也可以用 percentile
     const xs = endPoints.map(p => p.x).sort((a,b)=>a-b)
     const ys = endPoints.map(p => p.y).sort((a,b)=>a-b)
     
     // 假设网格是相对完整的，取 5% 和 95% 分位点作为边界估计
     // 避免个别噪点影响
     const p5 = Math.floor(endPoints.length * 0.05)
     const p95 = Math.floor(endPoints.length * 0.95)
     
     // 更智能的方法：寻找最密集的边缘
     // 但简单的 percentile 在大多数“整齐”的网格图中通常有效
     // 用户提到的“连线”逻辑：实际上就是寻找这些端点的外包矩形
     
     const xMin = xs[p5]
     const xMax = xs[p95]
     const yMin = ys[p5]
     const yMax = ys[p95]
     
     if(xMax > xMin && yMax > yMin){
        bounds = { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin }
     }
  }

  // 10. 修正 anchors / offset 以对齐到检测到的边界
  // 我们希望网格的某个节点正好落在 (bounds.x, bounds.y)
  // 但实际上，网格的左上角 (bounds.x, bounds.y) 并不一定是顶点，可能是边的中点
  // 更好的策略是：保持原本的 anchors（因为它们是对齐到线条中心的），
  // 但是告诉上层应用，网格的绘制范围应该是 bounds。
  // 同时，我们可以微调 offset，使得网格在 bounds.x, bounds.y 处看起来是“切齐”的。
  
  // 计算相对于边界的 offset
  // 水平线的 Phase 应该让第一条线出现在 bounds.y 附近
  // 垂直/斜线的 Phase 应该让第一条线出现在 bounds.x 附近
  // 这里的 anchors 已经是 rho (原点到直线的距离)。
  // 我们不需要改变 anchors，只需要返回 bounds 供裁剪使用。
  
  return {
    success: true,
    mode,
    spacing: bestSpacing, 
    side: finalSide,      
    anchors, 
    angles: targetAngles,
    gridLines,
    activeSegments, // 调试用：实际检测到的线段
    bounds          // 新增：推断出的网格边界 {x, y, width, height}
  }
}
