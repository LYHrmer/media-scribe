// Hash helpers for the file-hash tool page. The digest itself is one
// crypto.subtle call (available in Node 24 and every modern browser);
// everything else is pure string handling kept here for node tests.
export const HASH_ALGOS = ['SHA-256', 'SHA-1', 'SHA-512'];
// Above a few hundred MB arrayBuffer() copies get risky in a tab; fail fast
// with a clear message instead of letting the renderer run out of memory.
export const MAX_HASH_BYTES = 500 * 1024 * 1024;

export async function hashBuffer(buffer, algo) {
  const digest = await crypto.subtle.digest(algo, buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Users paste hashes with spaces/newlines/uppercase straight from release
// pages — all of that is presentation, not content.
export function normalizeHash(text) {
  return String(text).replace(/\s+/g, '').toLowerCase();
}

export function compareHash(actual, expected) {
  const clean = normalizeHash(expected);
  if (!clean) return 'idle';
  if (!/^[0-9a-f]+$/.test(clean)) return 'invalid';
  return actual === clean ? 'match' : 'mismatch';
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value >= 100 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}
