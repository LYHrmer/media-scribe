import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { runRegex, MAX_MATCHES } from '../lib/regex-tools.js';
import { wireFilePicker, wireFileDrop } from '../lib/file-picker.js';

const $ = id => document.getElementById(id);
const FLAGS = ['i', 'm', 's', 'u', 'y'];
const MAX_LIST_ROWS = 50;

function selectedFlags() {
  return FLAGS.filter(f => $(`flag-${f}`).checked).join('');
}

function showError(message) {
  const box = $('tool-error');
  box.textContent = message;
  box.hidden = !message;
}

function renderHighlight(text, matches) {
  const view = $('regex-view');
  view.replaceChildren();
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const m of matches) {
    if (m.index > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, m.index)));
    if (m.match.length > 0) {
      const mark = document.createElement('mark');
      mark.textContent = m.match;
      fragment.appendChild(mark);
    }
    cursor = m.index + m.match.length;
  }
  fragment.appendChild(document.createTextNode(text.slice(cursor)));
  view.appendChild(fragment);
}

function renderMatchList(matches) {
  const list = $('match-list');
  list.replaceChildren();
  matches.slice(0, MAX_LIST_ROWS).forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'match-row';
    const groups = m.groups.length
      ? `  分组: ${m.groups.map(g => (g === undefined ? '∅' : `"${g}"`)).join(', ')}`
      : '';
    const named = m.named && Object.keys(m.named).length
      ? `  命名: ${Object.entries(m.named).map(([k, v]) => `${k}="${v}"`).join(', ')}`
      : '';
    row.textContent = `#${i + 1} @${m.index} "${m.match}"${groups}${named}`;
    list.appendChild(row);
  });
}

function render() {
  showError('');
  const pattern = $('regex-pattern').value;
  const text = $('regex-text').value;
  const view = $('regex-view');
  const list = $('match-list');
  const status = $('regex-status');
  if (!pattern) {
    view.hidden = true;
    list.hidden = true;
    status.hidden = true;
    return;
  }
  const result = runRegex(pattern, selectedFlags(), text);
  if (!result.ok) {
    showError(result.message);
    view.hidden = true;
    list.hidden = true;
    status.hidden = true;
    return;
  }
  renderHighlight(text, result.matches);
  renderMatchList(result.matches);
  const parts = [`匹配 ${result.matches.length} 条`];
  if (result.truncated) parts.push(`已达上限 ${MAX_MATCHES} 条，仅统计前 ${MAX_MATCHES} 条`);
  if (result.matches.length > MAX_LIST_ROWS) parts.push(`列表仅列前 ${MAX_LIST_ROWS} 条`);
  status.textContent = parts.join('；');
  status.hidden = false;
  view.hidden = false;
  list.hidden = result.matches.length === 0;
}

$('regex-pattern').addEventListener('input', render);
$('regex-text').addEventListener('input', render);
for (const f of FLAGS) $(`flag-${f}`).addEventListener('change', render);

wireFilePicker($('regex-file-button'), $('regex-file-input'), $('regex-text'), { onFile: render });
wireFileDrop($('regex-text'), { onFile: render });
