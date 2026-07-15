import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/next/',
  plugins: [react()],
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://127.0.0.1:8800' } },
  test: { environment: 'jsdom', globals: true },
})
