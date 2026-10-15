import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { diffLines } from '../lib/line-diff.js';
import { wireFilePicker } from '../lib/file-picker.js';

const $ = id => document.getElementById(id);
const ROW_CLASS = { add: 'diff-add', del: 'diff-del', same: 'diff-same' };

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

$('run-button').addEventListener('click', () => {
  showError('');
  $('coarse-hint').hidden = true;
  $('diff-view').hidden = true;
  $('diff-stats').textContent = '';
  const result = diffLines($('diff-a').value, $('diff-b').value);
  if (!result.ok) {
    showError(result.message);
    return;
  }
  const view = $('diff-view');
  view.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const op of result.ops) {
    const row = document.createElement('div');
    row.className = `diff-row ${ROW_CLASS[op.type]}`;
    row.textContent = op.text === '' ? ' ' : op.text;
    fragment.appendChild(row);
  }
  view.appendChild(fragment);
  view.hidden = false;
  $('diff-stats').innerHTML = `新增 <span class="stat-add">${result.added}</span> 行 · 删除 <span class="stat-del">${result.removed}</span> 行`;
  if (result.coarse) $('coarse-hint').hidden = false;
});

wireFilePicker($('diff-a-file-button'), $('diff-a-file-input'), $('diff-a'), { onError: showError });
wireFilePicker($('diff-b-file-button'), $('diff-b-file-input'), $('diff-b'), { onError: showError });
