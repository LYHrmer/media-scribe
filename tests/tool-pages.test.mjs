import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// Static wiring checks for the toolbox pages: node tests cover the libs, but
// not the DOM glue. These assertions lock in the invariants that otherwise
// only fail in a browser: every id referenced from a page's glue module must
// exist in its HTML, copy-button data-targets must resolve, each page must
// load exactly one existing module script, and hub card links must resolve.
const PAGES = [
  ['subtitle.html', 'src/tools/subtitle.js'],
  ['json-format.html', 'src/tools/json-format.js'],
  ['text-diff.html', 'src/tools/text-diff.js'],
  ['codec-time.html', 'src/tools/codec-time.js'],
];
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const has = path => existsSync(new URL(`../${path}`, import.meta.url));

test('glue-referenced element ids exist in each tool page', () => {
  for (const [page, glue] of PAGES) {
    const html = read(page);
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const refs = new Set([...read(glue).matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
    for (const ref of refs) {
      assert.ok(ids.has(ref), `${glue} references id "${ref}" missing from ${page}`);
    }
    for (const m of html.matchAll(/data-target="([^"]+)"/g)) {
      assert.ok(ids.has(m[1]), `${page} data-target "${m[1]}" has no matching id`);
    }
  }
});

test('each tool page loads exactly one existing module script named after it', () => {
  for (const [page] of PAGES) {
    const scripts = [...read(page).matchAll(/<script type="module" src="\/src\/([^"]+)"/g)];
    assert.equal(scripts.length, 1, `${page} should load exactly one module script`);
    assert.equal(scripts[0][1], `tools/${page.replace('.html', '.js')}`, `${page} loads its own glue`);
    assert.ok(has(`src/${scripts[0][1]}`), `${page} script src/${scripts[0][1]} does not exist`);
  }
});

test('hub cards link to pages that exist', () => {
  const hrefs = [...read('index.html').matchAll(/href="\.\/([a-z-]+\.html)"/g)].map(m => m[1]);
  assert.ok(hrefs.length >= 5, 'hub should link the flagship plus all tools');
  for (const href of hrefs) assert.ok(has(href), `hub link ${href} does not exist`);
});

test('subtitle mode tabs match parameter sections', () => {
  const html = read('subtitle.html');
  const modes = [...html.matchAll(/data-mode="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(modes, ['convert', 'merge', 'shift', 'split']);
  for (const mode of ['shift', 'merge', 'split']) {
    assert.ok(html.includes(`id="param-${mode}"`), `subtitle.html missing param section for mode ${mode}`);
  }
});
