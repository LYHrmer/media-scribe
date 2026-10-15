import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { convertSubtitle, shiftSubtitle, mergeSubtitles, splitSubtitle } from '../lib/subtitle-cues.js';
import { wireFilePicker, fileBaseName } from '../lib/file-picker.js';
import { downloadText } from '../exports.js';

const $ = id => document.getElementById(id);
const MODE_PARAMS = { convert: [], shift: ['param-shift'], merge: ['param-merge'], split: ['param-split'] };
let mode = 'convert';
let downloads = [];
const sourceNames = { a: '', b: '' };

document.querySelectorAll('.tool-tabs .tab-button').forEach(button => {
  button.addEventListener('click', () => {
    mode = button.dataset.mode;
    document.querySelectorAll('.tool-tabs .tab-button').forEach(other => {
      const active = other === button;
      other.classList.toggle('active', active);
      other.setAttribute('aria-selected', String(active));
    });
    for (const [name, ids] of Object.entries(MODE_PARAMS)) {
      ids.forEach(id => { $(id).hidden = name !== mode; });
    }
  });
});

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function showWarnings(list) {
  const el = $('tool-warnings');
  el.replaceChildren();
  (list || []).forEach(warning => {
    const li = document.createElement('li');
    li.textContent = warning;
    el.appendChild(li);
  });
  el.hidden = !list || list.length === 0;
}

function renderResult(result, base) {
  const section = $('result-section');
  section.hidden = false;
  const output = $('sub-output');
  if (result.part1) {
    output.value = result.part1.text;
    $('result-meta').textContent = ` · 第 1 段 ${result.part1.count} 条，第 2 段 ${result.part2.count} 条`;
    downloads = [
      { text: result.part1.text, filename: `${base}-第1段.${result.format}` },
      { text: result.part2.text, filename: `${base}-第2段.${result.format}` },
    ];
    $('download-button').textContent = '下载第一段';
    $('download-button-2').hidden = false;
  } else {
    output.value = result.text;
    $('result-meta').textContent = ` · ${result.count} 条`;
    const format = result.to || result.format;
    downloads = [{ text: result.text, filename: `${base}.${format}` }];
    $('download-button').textContent = '下载结果';
    $('download-button-2').hidden = true;
  }
}

$('run-button').addEventListener('click', () => {
  showError('');
  showWarnings([]);
  try {
    const input = $('sub-input-a').value;
    let result;
    if (mode === 'convert') result = convertSubtitle(input);
    else if (mode === 'shift') result = shiftSubtitle(input, Number($('shift-ms').value));
    else if (mode === 'merge') result = mergeSubtitles(input, $('sub-input-b').value);
    else result = splitSubtitle(input, Number($('split-at').value));
    showWarnings(result.warnings);
    const base = mode === 'merge'
      ? fileBaseName(sourceNames.a, '合并字幕')
      : fileBaseName(sourceNames.a, '字幕');
    renderResult(result, base);
  } catch (error) {
    $('result-section').hidden = true;
    showError(error.message);
  }
});

wireFilePicker($('a-file-button'), $('a-file-input'), $('sub-input-a'), {
  onError: showError,
  onFile: name => { sourceNames.a = name; },
});
wireFilePicker($('b-file-button'), $('b-file-input'), $('sub-input-b'), {
  onError: showError,
  onFile: name => { sourceNames.b = name; },
});

$('download-button').addEventListener('click', () => {
  if (downloads[0]) downloadText(downloads[0].text, downloads[0].filename);
});
$('download-button-2').addEventListener('click', () => {
  if (downloads[1]) downloadText(downloads[1].text, downloads[1].filename);
});
$('copy-button').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('sub-output').value);
  } catch {
    $('sub-output').select();
  }
});
