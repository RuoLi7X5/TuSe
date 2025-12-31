
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

  // 5. 全局间距分析
  const allDiffs = []
  anglePeaks.forEach(peaks => {
    for (let i = 1; i < peaks.length; i++) {
      const d = peaks[i].rho - peaks[i - 1].rho
      if (d > 5 && d < Math.min(width, height) / 2) {
        allDiffs.push(d)
      }
    }
  })

  if (allDiffs.length === 0) {
    return { success: false, reason: 'No lines detected' }
  }

  // 直方图统计
  const bins = {}
  const binSize = 2
  let maxBinCount = 0
  let bestBinStart = 0
  
  allDiffs.forEach(d => {
    const bin = Math.floor(d / binSize) * binSize
    bins[bin] = (bins[bin] || 0) + 1
    if (bins[bin] > maxBinCount) {
      maxBinCount = bins[bin]
      bestBinStart = bin
    }
  })

  // 基础频率分析
  const significantBins = []
  const maxVal = Math.max(...Object.values(bins))
  const histThreshold = Math.max(2, maxVal * 0.15)

  for (const [binStr, count] of Object.entries(bins)) {
    if (count >= histThreshold) {
      significantBins.push(parseFloat(binStr))
    }
  }
  significantBins.sort((a, b) => a - b)

  let bestSpacing = 0
  let fundamental = 0
  
  for (const base of significantBins) {
    if (base < 10) continue
    const ratio = bestBinStart / base
    const remainder = Math.abs(ratio - Math.round(ratio))
    if (remainder < 0.15) {
      fundamental = base
      break
    }
  }

  if (fundamental > 0) {
    let sum = 0, count = 0
    allDiffs.forEach(d => {
      if (Math.abs(d - (fundamental + binSize / 2)) < binSize * 2) {
        sum += d
        count++
      }
    })
    bestSpacing = count > 0 ? sum / count : fundamental + binSize / 2
  } else {
    let sum = 0, count = 0
    allDiffs.forEach(d => {
      if (Math.abs(d - (bestBinStart + binSize / 2)) < binSize * 1.5) {
        sum += d
        count++
      }
    })
    bestSpacing = count > 0 ? sum / count : 0
  }

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
        
        if (avgE > 0.6 * parentAvgE) validAngles++
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

  // 7. 返回完整的网格规格
  // 对于等边三角形网格，Height (h) = side * sqrt(3) / 2
  // 我们检测到的 bestSpacing 就是这个 h (垂直于网格线的距离)
  // 因此推导出的 side = bestSpacing / (sqrt(3)/2)
  const estimatedSide = bestSpacing / (Math.sqrt(3) / 2)

  return {
    success: true,
    mode,
    spacing: bestSpacing, // This is 'h' (height of triangle row), not side length
    side: estimatedSide,
    anchors, // [rho for angle0, rho for angle1, rho for angle2]
    angles: targetAngles
  }
}
