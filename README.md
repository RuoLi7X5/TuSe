# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
# 折纸图色（Web）

基于 React + Vite 的前端应用，用等边三角网格对图片进行采样与配色，支持编辑泼涂、自动求解最少步骤、以及导出网格图。项目已针对边界进行了多边形裁剪，画布四周为笔直直线，无角落缺口。

## 功能特性
- 图片分析与调色板生成：尊重 EXIF 方向，自动量化生成可用颜色。
- 自适应三角网格：按图片短边自动微调三角形尺寸，采样密度更稳健。
- 直线边缘画布：对边界三角进行矩形裁剪，保留为多边形并参与绘制/采样/导出。
- 网格旋转：支持 0°/90° 两种布局，快速切换观察效果。
- 编辑能力：泼涂、撤销/重做、选择同色、批量替换、删除选中、保存/进入编辑。
- 自动求解：计算统一为同色的最少步骤，提供实时进度日志与性能统计。
- 导出与快照：导出 PNG 网格图；导入/导出工程快照（JSON）以无损复现状态。

## 快速开始

要求：Node.js 18+（推荐 20+）。

```bash
npm install
npm run dev
```

启动后访问 `http://localhost:5173/`（端口可能因并行进程为 5174）。

构建与本地预览：

```bash
npm run build
npm run preview
```

## 使用指南

1. 上传图片或截图，应用会自动生成调色板并构建三角网格。
2. 在“控制”面板：
   - 三角形尺寸：滑块调整采样密度。
   - 网格旋转：在 0°/90° 间切换。
   - 颜色分离强度：影响灰色惩罚与暖色边界，提升匹配稳定性。
3. 在画布上：
   - 点击三角形以设为起点；“泼涂”将起点连通区域替换为所选颜色。
   - Ctrl+点击：选择与该三角形同色且共享边连通的整片区域。
   - 框选：拖拽形成矩形后，可删除或批量替换为选色。
   - 撤销/重做随时回退操作。
4. 自动求解：点击“自动求解”计算最少步骤；进度区可“复制日志/清空”，并显示阶段、节点数、分量数等信息；可继续最短路径计算与路径优化。
5. 导出：保存编辑后，可直接导出当前画布 PNG；也可导出工程（JSON）并在之后导入恢复全部状态。

## 设计与实现要点

- 边界裁剪：使用 Sutherland–Hodgman 算法将越界三角裁剪为矩形内多边形，生成 `drawVertices` 与 `drawCentroid`，绘制与采样统一基于这些数据，确保四边直线且无缝。
- 点击命中：由 `pointInTriangle` 改为通用 `pointInPolygon`，支持边界多边形的准确交互。
- EXIF 方向：加载图片时启用 `createImageBitmap(blob, { imageOrientation: 'from-image' })`，避免宽高与方向失配导致比例失真。
- 采样与颜色匹配：在三角/多边形内取多点加权均值，进行离群剔除后匹配至调色板，提升边界与细节表现。

## 目录结构（简）

```
src/
  components/
    TriangleCanvas.jsx     # 画布绘制与交互（多边形绘制/命中）
    Controls.jsx           # 侧边控制面板与拾色器
    StepsPanel.jsx         # 自动求解结果展示
  utils/
    grid-utils.js          # 网格生成、边界裁剪、图像映射采样
    solver-worker.js       # Web Worker 端自动求解
    solver.js              # 导出、辅助与本地求解回退
    color-utils.js         # 颜色量化与 LAB 距离计算
```

## 常见问题

- 边缘仍有锯齿：尝试增大三角形尺寸或切换网格旋转；确认浏览器缩放不是非整数比。
- 导出为空或失败：需先“保存编辑”后导出 PNG；或使用工程导出（JSON）。
- 端口被占用：Vite 会自动切换到 5174，终端会显示实际访问地址。

## 贡献与开发

欢迎提交 Issue/PR 来改进网格算法、配色策略与性能。建议在新特性前先讨论需求与交互细节，以保持简洁一致的用户体验。
# 折纸图色（Web）

一个基于 React + Vite 的前端应用，用等边三角网格对图片进行采样与配色，支持编辑泼涂、自动求解最少步骤，并导出网格图。项目已实现边界裁剪，画布四周为笔直直线。

## 项目介绍
- 上传图片后自动量化生成调色板，并构建三角网格进行颜色映射。
- 交互支持：泼涂、撤销/重做、选择同色、框选删除/批量替换、保存编辑。
- 自动求解：计算统一为同色的最少步骤，实时显示进度与性能统计。
- 导出：保存后可导出当前画布 PNG；支持工程（JSON）快照导入/导出以复现状态。

## 特色与策略
- EXIF 方向尊重：加载图片使用 `createImageBitmap(..., { imageOrientation: 'from-image' })`，避免比例失真。
- 自适应采样密度：默认三角形尺寸随图片短边自调，采样更稳定。
- 边界直线裁剪：对越界三角使用 Sutherland–Hodgman 算法裁剪为矩形内多边形，生成 `drawVertices`/`drawCentroid`；绘制、命中与采样统一基于裁剪后的多边形。
- 命中检测：由三角命中改为通用 `pointInPolygon`，边界交互准确。
- 颜色映射：多点加权 LAB 均值并做离群剔除，提升边界与细节表现；使用调色板最近邻匹配。
- 求解策略：DFS 优先、可行解早停、组件/边界权重与桥优先等启发式，加速最短步骤搜索，并提供进度日志。

## 使用方法

环境要求：Node.js 18+（推荐 20+）。

在线部署地址
- 生产环境：https://tuse-37e.pages.dev/

开发启动：
```bash
npm install
npm run dev
# 浏览器访问： http://localhost:5173/ （并行进程可能为 5174）
```

构建与本地预览：
```bash
npm run build
npm run preview
```

## 注意事项
- 导出 PNG 前需“保存编辑”，否则导出为空或旧内容。
- 浏览器缩放建议为 100%，避免非整数缩放造成视觉锯齿错觉。
- 调整“三角形尺寸”与“网格旋转（0°/90°）”可获得不同采样与边缘效果。
- 大图或高密度采样下自动求解耗时会增加，可调整“步数上限”或性能调优（右上角性能面板）。

## Cloudflare Pages 部署（免费）

将 GitHub 仓库托管到 Cloudflare Pages：
1. 登录 Cloudflare，进入 Pages，创建项目，选择“连接到 GitHub”，选中当前仓库。
2. 框架预设：选择 `Vite`（或自定义）。
3. 构建命令：`npm run build`
4. 输出目录：`dist`
5. Node 版本：设置为 `20`（环境变量 `NODE_VERSION=20` 或在构建设置中选择）。
6. 可选环境变量：`CI=true`（稳定构建），如需自定义基础路径可设置 `VITE_BASE` 并在 `vite.config.js` 使用。
7. 提交后自动构建与发布，Pages 会提供生产地址与预览地址。

无需后端即可发布；如需纯静态上传，也可在 Pages 选择“直接上传”，将 `dist/` 打包上传。
