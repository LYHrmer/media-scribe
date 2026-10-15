import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { HASH_ALGOS, MAX_HASH_BYTES, hashBuffer, compareHash, formatBytes } from '../lib/hash-tools.js';

const $ = id => document.getElementById(id);
// algo name → id suffix used by the page's hash rows ('SHA-256' → 'sha256')
const ROWS = HASH_ALGOS.map(algo => [algo, algo.toLowerCase().replace('-', '')]);

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function showStatus(message) {
  const el = $('hash-status');
  el.textContent = message || '';
  el.hidden = !message;
}

function refreshCompare() {
  const expected = $('hash-expected').value;
  for (const [, suffix] of ROWS) {
    const actual = $(`hash-${suffix}`).value;
    const badge = $(`cmp-${suffix}`);
    const verdict = compareHash(actual, expected);
    badge.className = `hash-cmp hash-cmp-${verdict}`;
    badge.textContent = { idle: '', invalid: '期望哈希不是十六进制', match: '✓ 一致', mismatch: '✗ 不一致' }[verdict];
  }
}

async function hashFile(file) {
  showError('');
  showStatus('');
  if (file.size > MAX_HASH_BYTES) {
    showError(`文件 ${formatBytes(file.size)} 超过 500 MB 上限，请换更小的文件。`);
    return;
  }
  $('file-info').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $('file-info').hidden = false;
  $('result-section').hidden = true;
  showStatus('正在计算…');
  try {
    const buffer = await file.arrayBuffer();
    for (const [algo, suffix] of ROWS) {
      $(`hash-${suffix}`).value = await hashBuffer(buffer, algo);
    }
    $('result-section').hidden = false;
    showStatus('计算完成');
    refreshCompare();
  } catch {
    showError('读取文件失败，请重试。');
    showStatus('');
  }
}

const drop = $('hash-drop');
drop.addEventListener('click', () => $('hash-file-input').click());
drop.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    $('hash-file-input').click();
  }
});
$('hash-file-input').addEventListener('change', () => {
  const file = $('hash-file-input').files[0];
  $('hash-file-input').value = '';
  if (file) hashFile(file);
});
drop.addEventListener('dragover', event => {
  event.preventDefault();
  drop.classList.add('tool-drop-active');
});
drop.addEventListener('dragleave', () => drop.classList.remove('tool-drop-active'));
drop.addEventListener('drop', event => {
  event.preventDefault();
  drop.classList.remove('tool-drop-active');
  const file = event.dataTransfer.files[0];
  if (file) hashFile(file);
});

$('hash-expected').addEventListener('input', refreshCompare);

document.querySelectorAll('.copy-button').forEach(button => {
  button.addEventListener('click', async () => {
    const target = $(button.dataset.target);
    try {
      await navigator.clipboard.writeText(target.value);
    } catch {
      target.select();
    }
  });
});
