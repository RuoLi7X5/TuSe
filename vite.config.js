import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 开发代理：前端请求 /api/deepseek 将被转发到 DeepSeek Chat Completions
      '/api/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        secure: true,
        // 路径重写到 v1/chat/completions
        rewrite: (path) => path.replace(/^\/api\/deepseek$/, '/v1/chat/completions'),
      },
    },
  },
})
