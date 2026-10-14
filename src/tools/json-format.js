import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { formatJson, validateJson } from '../lib/json-tools.js';
import { downloadText } from '../exports.js';

const $ = id => document.getElementById(id);

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function showStatus(message) {
  const el = $('tool-status');
  el.textContent = message || '';
  el.hidden = !message;
}

function describeError(result) {
  if (Number.isInteger(result.line) && Number.isInteger(result.column)) {
    return `第 ${result.line} 行第 ${result.column} 列：${result.message}`;
  }
  return result.message;
}

function run(action) {
  showError('');
  showStatus('');
  $('result-section').hidden = true;
  const text = $('json-input').value;
  if (!text.trim()) {
    showError('请先粘贴 JSON 内容');
    return;
  }
  if (action === 'validate') {
    const result = validateJson(text);
    if (result.ok) showStatus('JSON 有效 ✓');
    else showError(describeError(result));
    return;
  }
  const result = formatJson(text, {
    sortKeys: $('sort-keys').checked,
    minify: action === 'minify',
  });
  if (!result.ok) {
    showError(describeError(result));
    return;
  }
  $('json-output').value = result.result;
  $('result-section').hidden = false;
  showStatus(`处理完成 · ${result.result.length} 个字符`);
}

$('format-button').addEventListener('click', () => run('format'));
$('minify-button').addEventListener('click', () => run('minify'));
$('validate-button').addEventListener('click', () => run('validate'));
$('copy-button').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('json-output').value);
  } catch {
    $('json-output').select();
  }
});
$('download-button').addEventListener('click', () => {
  const text = $('json-output').value;
  if (text) downloadText(text, '格式化.json', 'application/json');
});
