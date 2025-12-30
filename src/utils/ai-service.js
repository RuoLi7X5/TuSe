
// AI 服务：本地几何分割引擎
// 移除了远程 Cloudflare/Hugging Face 依赖，完全使用本地 Canvas API 进行计算
// 针对“纯色块几何图形”，采用颜色聚类+区域生长算法

class AIService {
  // 初始化
  static async init() {
    return true;
  }

  // 核心：本地几何分割引擎
  // 针对“纯色块几何图形”，传统的计算机视觉算法（颜色聚类+区域生长）往往比通用 AI 模型更准确
  static async computeLocalSegmentation(imgBlob, points) {
    console.log('[Local] Running Geometric Segmentation Engine...');
    
    // 1. 准备图像数据
    const img = await createImageBitmap(imgBlob);
    const w = img.width;
    const h = img.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // 2. 提取种子颜色（从 Points 中）
    const seeds = []; // { color: hex, lab: [l,a,b], points: [] }
    const colorMap = new Map(); // hex -> seedIndex
    
    // 简单的 RGB 转 Lab
    const rgb2lab = (r, g, b) => {
      let r1=r/255, g1=g/255, b1=b/255;
      r1=(r1>0.04045)?Math.pow((r1+0.055)/1.055,2.4):r1/12.92;
      g1=(g1>0.04045)?Math.pow((g1+0.055)/1.055,2.4):g1/12.92;
      b1=(b1>0.04045)?Math.pow((b1+0.055)/1.055,2.4):b1/12.92;
      let x=(r1*0.4124+g1*0.3576+b1*0.1805)/0.95047;
      let y=(r1*0.2126+g1*0.7152+b1*0.0722)/1.00000;
      let z=(r1*0.0193+g1*0.1192+b1*0.9505)/1.08883;
      x=(x>0.008856)?Math.pow(x,1/3):(7.787*x)+16/116;
      y=(y>0.008856)?Math.pow(y,1/3):(7.787*y)+16/116;
      z=(z>0.008856)?Math.pow(z,1/3):(7.787*z)+16/116;
      return [(116*y)-16, 500*(x-y), 200*(y-z)];
    };

    points.forEach(p => {
        if (!colorMap.has(p.color)) {
            const hex = p.color;
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            seeds.push({ 
                color: hex, 
                lab: rgb2lab(r, g, b),
                points: [p] // 记录属于这个颜色的所有提示点
            });
            colorMap.set(hex, seeds.length - 1);
        } else {
            seeds[colorMap.get(p.color)].points.push(p);
        }
    });

    // 3. 像素分类（基于颜色距离）
    // 创建 Label Map
    const labels = new Int32Array(w * h);
    
    for (let i = 0; i < w * h; i++) {
        const idx = i * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        const lab = rgb2lab(r, g, b);
        
        // 寻找最近的种子颜色
        let minDist = Infinity;
        let bestLabel = -1;
        
        for (let k = 0; k < seeds.length; k++) {
            const s = seeds[k];
            // Lab 欧氏距离
            const dL = lab[0] - s.lab[0];
            const da = lab[1] - s.lab[1];
            const db = lab[2] - s.lab[2];
            const dist = dL*dL + da*da + db*db;
            
            if (dist < minDist) {
                minDist = dist;
                bestLabel = k;
            }
        }
        labels[i] = bestLabel;
    }

    // 4. 生成 Masks
    // 为每个种子颜色生成一个 Mask
    const results = seeds.map((seed, labelIdx) => {
        // 创建 mask 数据 (单通道)
        const maskData = new Uint8Array(w * h);
        let hasForeground = false;
        
        for (let i = 0; i < w * h; i++) {
            if (labels[i] === labelIdx) {
                maskData[i] = 1; // Foreground
                hasForeground = true;
            } else {
                maskData[i] = 0;
            }
        }
        
        if (!hasForeground) return null;

        // 选取一个代表点（通常是第一个 prompt 点）
        const repPoint = seed.points[0];

        return {
            point: repPoint,
            maskRaw: {
                data: maskData,
                width: w,
                height: h
            },
            score: 1.0 // 本地算法置信度设为 1
        };
    }).filter(r => r !== null);

    console.log(`[Local] Engine generated ${results.length} masks.`);
    return {
        type: 'local_geo',
        results,
        errors: [],
        maskSize: w, // 本地计算使用原图尺寸
        originalSize: { width: w, height: h }
    };
  }

  /**
   * 执行图像分割（仅使用本地引擎）
   * @param {string} imageUrl - 图片 URL
   * @param {Array<{x:number, y:number, label:number, color:string}>} points - 提示点列表
   */
  static async segmentImageWithPoints(imageUrl, points, progressCallback) {
    console.log('[Local] Preparing geometric segmentation...');
    
    // 1. 下载图片 (Blob)
    const imgRes = await fetch(imageUrl);
    const imgBlob = await imgRes.blob();
    
    if (progressCallback) progressCallback({ status: 'processing', progress: 50 });

    // 2. 直接调用本地引擎
    try {
        const result = await this.computeLocalSegmentation(imgBlob, points);
        if (progressCallback) progressCallback({ status: 'done', progress: 100 });
        return result;
    } catch (error) {
        console.error('[Local] Segmentation Failed:', error);
        throw error;
    }
  }
}

export default AIService;
