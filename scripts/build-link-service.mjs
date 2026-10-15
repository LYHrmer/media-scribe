import { readdir, mkdir, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// GitHub Pages remains a normal static build. Sites packages the same client
// with an HTTP-only Worker; no Python, subprocess, user credentials or model API.
if (process.env.SITES_LINK_SERVICE === '1') {
  const entries = await readdir('dist');
  await mkdir('dist/client', { recursive: true });
  for (const entry of entries) {
    if (entry === '.openai') continue;
    await rename(`dist/${entry}`, `dist/client/${entry}`);
  }
  const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.server.config.js'], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
  await writeFile('dist/server/wrangler.json', JSON.stringify({
    name: 'tingxie-link-service', main: 'index.js', compatibility_date: '2026-10-15',
    assets: { directory: '../client', binding: 'ASSETS' },
  }, null, 2)+'\n');
}
