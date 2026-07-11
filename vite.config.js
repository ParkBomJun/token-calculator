import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Pages 프로젝트 페이지(https://<user>.github.io/<repo>/)에서도 동작하도록 상대 경로 사용
  base: './',
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 3000, // gpt-tokenizer 어휘가 순수 JS로 포함되어 청크가 큼 (정상)
  },
})
