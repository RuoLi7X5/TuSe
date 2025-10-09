// DeepSeek 远程求解适配器（浏览器端）
// 注意：直接从浏览器请求多数 AI 提供商会触发 CORS 与密钥暴露风险。
// 推荐在服务端做代理转发（见下文 proxyEndpoint 说明）。

/**
 * 将当前画布状态发送到 DeepSeek，按“最少步骤统一颜色”的策略返回求解结果。
 * 返回格式与本地自动求解保持一致：{ bestStartId, paths, minSteps }
 *
 * options:
 * - apiKey: 直接调用 DeepSeek 时使用的密钥（不推荐在前端放置）。
 * - endpoint: DeepSeek Chat Completions 接口，默认 https://api.deepseek.com/chat/completions
 * - model: 模型名称，默认 deepseek-chat（或 deepseek-reasoner）。
 * - proxyEndpoint: 更安全的服务器代理地址（推荐），前端仅发送画布数据，不暴露密钥。
 * - maxPaths: 期望返回的候选分支数量（默认 3）。
 * - stepLimit: 步数上限，用于约束搜索与生成（默认 60）。
 */
export async function solveWithDeepSeek(triangles, palette, options = {}) {
  const {
    apiKey = import.meta?.env?.VITE_DEEPSEEK_API_KEY,
    endpoint = 'https://api.deepseek.com/v1/chat/completions',
    model = import.meta?.env?.VITE_DEEPSEEK_MODEL || 'deepseek-chat',
    proxyEndpoint = import.meta?.env?.VITE_DEEPSEEK_PROXY,
    maxPaths = 3,
    stepLimit = 60,
  } = options

  if (!Array.isArray(triangles) || triangles.length === 0) {
    throw new Error('no-triangles')
  }
  if (!Array.isArray(palette) || palette.length < 2) {
    throw new Error('palette-too-small')
  }

  // 压缩画布数据，避免传输过大
  const compact = triangles.map(t => ({ id: t.id, color: t.color, neighbors: t.neighbors }))
  const payload = {
    palette,
    triangles: compact,
    constraints: { maxPaths, stepLimit },
  }

  // 优先使用后端代理，避免 CORS 与密钥泄露
  if (proxyEndpoint) {
    const resp = await fetch(proxyEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) throw new Error(`proxy-error-${resp.status}`)
    const data = await resp.json()
    return normalizeResult(data)
  }

  // 直接调用 DeepSeek（仅示例，生产不建议在前端使用 apiKey）
  if (!apiKey) throw new Error('missing-api-key')
  const messages = buildPromptMessages(payload)
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  })
  if (!resp.ok) throw new Error(`deepseek-error-${resp.status}`)
  const json = await resp.json()
  const content = json?.choices?.[0]?.message?.content || ''
  let parsed
  try {
    parsed = JSON.parse(extractJson(content))
  } catch {
    // 容错：尝试直接解析完整 content
    try { parsed = JSON.parse(content) } catch(e) { throw new Error('invalid-json') }
  }
  return normalizeResult(parsed)
}

function buildPromptMessages(payload) {
  const { triangles, palette, constraints } = payload
  const sys = `你是图搜索与组合优化专家。任务：在给定三角网格连通图中，模拟“泼涂”操作，将起点连通区域的颜色依次替换为选定颜色，目标是使整张画布最终统一为一种颜色。输出严格 JSON。`
  const user = {
    role: 'user',
    content: JSON.stringify({
      task: 'min_steps_unify_colors',
      palette,
      triangles,
      constraints,
      output: {
        description: '返回自动选择起点的最少步数与候选路径',
        schema: {
          bestStartId: 'number',
          minSteps: 'number',
          paths: 'Array<Array<string>> // 每个路径为颜色 hex 列表',
        },
      },
      rules: [
        '泼涂：每一步选择一种颜色，将起点连通区域内所有三角形改为该颜色，然后连通区域随之扩张。',
        '步数定义为颜色更改次数。',
        '需保证最终画布颜色完全统一才算有效路径。',
        '返回 topK 候选路径，不超过 constraints.maxPaths。',
        '步数不得超过 constraints.stepLimit。',
      ],
    }),
  }
  return [ { role:'system', content: sys }, user ]
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/)
  return m ? m[0] : text
}

function normalizeResult(data) {
  const bestStartId = Number(data?.bestStartId)
  const minSteps = Number(data?.minSteps)
  const rawPaths = Array.isArray(data?.paths) ? data.paths : []
  const paths = rawPaths
    .filter(p => Array.isArray(p) && p.every(c => typeof c === 'string'))
    .map(p => p.slice())
  if (!Number.isFinite(bestStartId) || !Number.isFinite(minSteps) || paths.length === 0) {
    throw new Error('result-shape-invalid')
  }
  return { bestStartId, minSteps, paths }
}

export default { solveWithDeepSeek }