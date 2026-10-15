import { defineConfig } from 'vite';
import { sites } from './build/sites-vite-plugin';
export default defineConfig({
  publicDir: false,
  plugins: [sites({ mockAuth: false })],
  build: { ssr: 'server/index.js', outDir: 'dist/server', target: 'es2022',
    rollupOptions: { output: { entryFileNames: 'index.js' } } },
});
