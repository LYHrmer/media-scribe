import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const entry = name => fileURLToPath(new URL(`./${name}`, import.meta.url));

export default defineConfig({
  base: process.env.APP_BASE_PATH || '/',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      input: {
        index: entry('index.html'),
        transcribe: entry('transcribe.html'),
        subtitle: entry('subtitle.html'),
        'json-format': entry('json-format.html'),
        'text-diff': entry('text-diff.html'),
        'codec-time': entry('codec-time.html'),
        regex: entry('regex.html'),
        'file-hash': entry('file-hash.html'),
        'text-stats': entry('text-stats.html'),
        'ts-batch': entry('ts-batch.html'),
        markdown: entry('markdown.html'),
        qr: entry('qr.html'),
      },
    },
  },
});
