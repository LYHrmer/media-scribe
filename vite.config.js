import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.APP_BASE_PATH || '/',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});
