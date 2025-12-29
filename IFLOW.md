# 折纸图色（Web）项目文档

## 项目概述

折纸图色是一个基于 React + Vite 的前端应用，主要功能是使用等边三角网格对图片进行采样与配色，支持编辑泼涂、自动求解最少步骤、以及导出网格图。项目已针对边界进行了多边形裁剪，确保画布四周为笔直直线，无角落缺口。

### 核心功能
- **图片分析与调色板生成**：尊重 EXIF 方向，自动量化生成可用颜色
- **自适应三角网格**：按图片短边自动微调三角形尺寸，采样密度更稳健
- **直线边缘画布**：对边界三角进行矩形裁剪，保留为多边形并参与绘制/采样/导出
- **网格旋转**：支持 0°/90° 两种布局，快速切换观察效果
- **编辑能力**：泼涂、撤销/重做、选择同色、批量替换、删除选中、保存/进入编辑
- **自动求解**：计算统一为同色的最少步骤，提供实时进度日志与性能统计
- **导出与快照**：导出 PNG 网格图；导入/导出工程快照（JSON）以无损复现状态

### 技术栈
- **前端**：React 19.1.1 + Vite (rolldown-vite)
- **后端**：Node.js + Express + MongoDB
- **其他**：Web Workers、Canvas API、Sutherland–Hodgman 裁剪算法

## 项目结构

```
D:\Trae\zhezhituse\
├───.gitignore
├───eslint.config.js
├───index.html
├───package-lock.json
├───package.json          # 前端项目配置
├───README.md             # 项目说明文档
├───vite.config.js        # Vite 配置，包含代理设置
├───.git\...
├───.trae\
├───dist\...               # 构建输出目录
├───node_modules\...
├───public\               # 静态资源
│   ├───vite.svg
│   └───pdb\              # 模式数据库
│       ├───index.json
│       └───pdb_6x6.json
├───server\               # 后端服务
│   ├───index.js          # 服务器入口
│   ├───package.json      # 后端依赖配置
│   ├───models\           # 数据模型
│   │   ├───AlgoScore.js
│   │   ├───Cache.js
│   │   ├───Event.js
│   │   ├───Graph.js
│   │   ├───Recommendation.js
│   │   ├───Run.js
│   │   ├───RunScore.js
│   │   ├───Strategy.js
│   │   └───UCB.js
│   └───node_modules\...
└───src\                  # 前端源码
    ├───App.css
    ├───App.jsx           # 主应用组件
    ├───index.css
    ├───main.jsx
    ├───assets\
    │   └───react.svg
    ├───components\       # React 组件
    │   ├───AdminDashboard.jsx
    │   ├───CentralHub.jsx
    │   ├───Controls.jsx
    │   ├───HelpPage.jsx
    │   ├───PerformanceTuner.jsx
    │   ├───StepsPanel.jsx
    │   ├───TriangleCanvas.jsx
    │   └───UploadPanel.jsx
    └───utils\            # 工具函数
        ├───bitset.js
        ├───blocking.js
        ├───color-utils.js
        ├───grid-utils.js
        ├───heuristics.js
        ├───learn.js
        ├───local-repair.js
        ├───mcts.js
        ├───pdb.js
        ├───sat.js
        ├───solver-worker.js
        ├───solver.js
        └───telemetry.js
```

## 构建和运行

### 前端开发
```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览构建结果
npm run preview

# 代码检查
npm run lint
```

### 后端服务
```bash
# 进入服务器目录
cd server

# 安装依赖
npm install

# 启动服务器（开发或生产）
npm start
# 或
npm run dev
```

### 环境要求
- Node.js 18+（推荐 20+）
- MongoDB（用于后端数据存储）

### 端口说明
- 前端开发服务器：`http://localhost:5173/`（端口可能因并行进程为 5174）
- 后端 API 服务器：`http://localhost:3001`

## 核心算法与实现

### 边界裁剪算法
使用 Sutherland–Hodgman 算法将越界三角裁剪为矩形内多边形，生成 `drawVertices` 与 `drawCentroid`，绘制与采样统一基于这些数据，确保四边直线且无缝。

### 点击命中检测
由 `pointInTriangle` 改为通用 `pointInPolygon`，支持边界多边形的准确交互。

### EXIF 方向处理
加载图片时启用 `createImageBitmap(blob, { imageOrientation: 'from-image' })`，避免宽高与方向失配导致比例失真。

### 采样与颜色匹配
在三角/多边形内取多点加权均值，进行离群剔除后匹配至调色板，提升边界与细节表现。

### 自动求解系统
- 使用 Web Worker 进行后台计算，避免阻塞 UI
- 支持多种搜索策略：DFS、Best-First、A*、Beam Search
- 包含启发式优化：桥接优先、连通分量分析、学习优先级
- 提供实时进度日志与性能统计

## API 接口

### 后端 API 端点
- `POST /api/runs/start` - 开始运行记录
- `POST /api/events` - 记录事件日志
- `POST /api/runs/finish` - 结束运行记录
- `GET /api/recommend/params` - 获取推荐参数
- `POST /api/auth/login` - 管理员登录
- `GET /api/health` - 健康检查

### 前端组件通信
- 通过 `window.SOLVER_FLAGS` 全局配置求解器参数
- 使用 Web Workers 进行计算密集型任务
- 前后端通过 REST API 进行数据交互

## 开发约定

### 代码风格
- 使用 ESLint 进行代码规范检查
- 组件采用函数式组件与 Hooks
- 工具函数模块化，按功能划分

### 文件命名
- 组件文件使用 PascalCase（如 `TriangleCanvas.jsx`）
- 工具文件使用 kebab-case（如 `grid-utils.js`）
- 常量使用 UPPER_SNAKE_CASE

### 状态管理
- 主要状态集中在 `App.jsx` 中管理
- 使用 `localStorage` 进行持久化配置存储
- 通过 `useCallback` 优化性能，避免不必要的重渲染

## 部署说明

### Cloudflare Pages 部署（免费）
1. 登录 Cloudflare，进入 Pages，创建项目，选择"连接到 GitHub"，选中当前仓库
2. 框架预设：选择 `Vite`（或自定义）
3. 构建命令：`npm run build`
4. 输出目录：`dist`
5. Node 版本：设置为 `20`（环境变量 `NODE_VERSION=20`）
6. 可选环境变量：`CI=true`（稳定构建）

### 后端部署
需要配置 MongoDB 连接字符串（环境变量 `MONGODB_URI`）和管理员密码（环境变量 `ADMIN_PASSWORD`）。

## 使用指南

1. 上传图片或截图，应用会自动生成调色板并构建三角网格
2. 在"控制"面板调整三角形尺寸、网格旋转和颜色分离强度
3. 在画布上点击三角形进行泼涂，使用 Ctrl+点击选择连通区域
4. 点击"自动求解"计算最少步骤，查看实时进度和性能统计
5. 保存编辑后可导出 PNG 网格图或工程快照（JSON）

## 特殊功能

### 性能调优
- 右上角性能面板可实时调整求解器参数
- 支持多种搜索策略组合
- 可设置计算时间预算和步数上限

### 遥测系统
- 自动记录求解过程和性能数据
- 支持学习式参数优化
- 提供图形化数据分析界面

### 模式数据库（PDB）
- 支持预加载模式数据库加速求解
- 可从本地或远程加载 PDB 文件
- 自动缓存常用模式