
export default {
  async fetch(request, env) {
    // 处理 CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-HF-Token"
        }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const inputs = await request.json();
      const imageBase64 = inputs.image; 
      
      // 硬编码 Token (用户提供)
      const token = env.HF_TOKEN;
      
      if (!token) {
        return new Response(JSON.stringify({ error: "Missing Hugging Face Token" }), { 
            status: 401,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // 使用 DETR 全景分割模型 (Hugging Face)
      const MODEL_ID = "facebook/detr-resnet-50-panoptic";
      
      // 尝试多个端点，因为 HF 正在迁移 API
      const endpoints = [
          `https://router.huggingface.co/hf-inference/models/${MODEL_ID}`,
          `https://router.huggingface.co/models/${MODEL_ID}`,
          `https://api-inference.huggingface.co/models/${MODEL_ID}`,
          // 兜底尝试：有时直接请求主域名的 inference 路径也可能被转发（虽然不推荐，但作为最后尝试）
          `https://huggingface.co/api/models/${MODEL_ID}` 
      ];

      let lastError = null;
      let successData = null;

      for (const url of endpoints) {
          try {
              console.log(`Trying HF Endpoint: ${url}`);
              const response = await fetch(url, {
                  method: "POST",
                  headers: {
                      "Authorization": `Bearer ${token}`,
                      "Content-Type": "application/json"
                  },
                  body: JSON.stringify({
                      inputs: imageBase64,
                      parameters: { wait_for_model: true }
                  })
              });

              if (response.ok) {
                  successData = await response.json();
                  break; // 成功，跳出循环
              } else {
                  const txt = await response.text();
                  lastError = `[${response.status}] ${txt} (URL: ${url})`;
                  // 如果是 503 (Loading)，通常应该等待，但这里简化处理
                  if (response.status !== 404 && response.status !== 410) {
                      // 如果不是“找不到”或“已移除”，可能是临时错误，但为了快速响应我们继续尝试下一个
                  }
              }
          } catch (e) {
              lastError = `[Network Error] ${e.message} (URL: ${url})`;
          }
      }

      if (successData) {
          return new Response(JSON.stringify(successData), {
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
      } else {
          throw new Error(`All endpoints failed. Last error: ${lastError}`);
      }

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
