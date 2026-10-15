import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { formatJson, validateJson } from '../lib/json-tools.js';
import { wireFilePicker, wireFileDrop, fileBaseName } from '../lib/file-picker.js';
import { downloadText } from '../exports.js';

const $ = id => document.getElementById(id);
let sourceName = '';

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

function offsetFromLineColumn(text, line, column) {
  let offset = 0;
  for (let i = 1; i < line; i += 1) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + column - 1, text.length);
}

// Put the caret on the parse error so the user sees where to fix.
function revealError(text, result) {
  if (!Number.isInteger(result.line) || !Number.isInteger(result.column)) return;
  const offset = offsetFromLineColumn(text, result.line, result.column);
  const input = $('json-input');
  input.focus();
  input.setSelectionRange(offset, Math.min(offset + 1, text.length));
}

function run(action) {
  showError('');
  showStatus('');
  $('result-section').hidden = true;
  const text = $('json-input').value.replace(/^﻿/, '');
  if (text !== $('json-input').value) $('json-input').value = text; // keep caret math aligned with what was parsed
  if (!text.trim()) {
    showError('请先粘贴 JSON 内容');
    return;
  }
  if (action === 'validate') {
    const result = validateJson(text);
    if (result.ok) showStatus('JSON 有效 ✓');
    else { showError(describeError(result)); revealError(text, result); }
    return;
  }
  const result = formatJson(text, {
    sortKeys: $('sort-keys').checked,
    minify: action === 'minify',
  });
  if (!result.ok) {
    showError(describeError(result));
    revealError(text, result);
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
  if (text) downloadText(text, `${fileBaseName(sourceName, '格式化')}.json`, 'application/json');
});
wireFilePicker($('json-file-button'), $('json-file-input'), $('json-input'), {
  onError: showError,
  onFile: name => { sourceName = name; },
});
wireFileDrop($('json-input'), { onError: showError, onFile: name => { sourceName = name; } });
