# 如何部署 Cloudflare AI Worker 代理

本项目使用 Cloudflare Workers AI 来运行 Segment Anything Model (SAM) 进行图像分割。为了解决跨域 (CORS) 问题并保护 API 密钥，推荐使用 **Worker 代理模式**。

请跟随以下步骤在 Cloudflare 上部署您的个人 AI 代理服务。

## 第一步：创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 在左侧菜单点击 **Workers & Pages**。
3. 点击 **Create Application** (创建应用)。
4. 点击 **Create Worker** (创建 Worker)。
5. 给 Worker 起个名字（例如 `zhezhituse-ai-proxy`），然后点击 **Deploy** (部署)。
   - *注意：此时部署的是默认的 "Hello World" 代码，不用担心，我们马上会修改它。*

## 第二步：配置 AI 模型绑定 (关键步骤)

**这一步非常重要，如果跳过，Worker 将无法调用 AI 模型。**

1. 在刚刚创建的 Worker 页面中，点击顶部的 **Settings** (设置) 选项卡。
2. 在左侧子菜单点击 **Bindings** (绑定) 或 **Variables** (变量) -> **Bindings**。
3. 点击 **Add binding** (添加绑定) 或 **Add**。
4. 选择绑定类型为 **Workers AI**。
5. 将 **Variable name** (变量名称) 设置为 `AI`。
   - *必须大写，必须是 `AI`，否则代码无法识别。*
6. 点击 **Deploy** (部署) 或 **Save and Deploy** 保存设置。

## 第三步：更新 Worker 代码

1. 点击顶部的 **Edit code** (编辑代码) 按钮，进入在线代码编辑器。
2. 找到左侧文件列表中的 `worker.js`。
3. 清空其中的所有代码。
4. 将本项目根目录下的 `cloudflare-worker-example.js` 文件内容完整复制并粘贴进去。
   - *代码位于：`d:\Trae\zhezhituse\cloudflare-worker-example.js`*
5. 点击右上角的 **Deploy** (部署) 按钮。

## 第四步：获取 URL 并配置

1. 部署成功后，回到 Worker 的概览页面 (Overview)。
2. 找到 **Preview URL** 或 **Routes** 部分，复制您的 Worker URL。
   - 格式通常为：`https://zhezhituse-ai-proxy.<你的用户名>.workers.dev`
3. 回到本应用的 **AI 配置** 界面（点击主界面 AI 按钮旁的 ⚙️）。
4. 选择 **Worker 代理** 模式。
5. 将复制的 URL 填入 **Worker URL** 输入框。
6. 点击 **保存配置**。

## 完成！

现在您可以点击“✨ AI 智能校准”按钮，系统将通过您刚刚部署的 Cloudflare Worker 快速完成图像分割任务。
