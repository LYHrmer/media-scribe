import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { analyzeText, readingTimeText } from '../lib/text-stats.js';
import { wireFilePicker, wireFileDrop } from '../lib/file-picker.js';

const $ = id => document.getElementById(id);

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

const NUMERIC_FIELDS = [
  ['words', 'stat-words'],
  ['chars', 'stat-chars'],
  ['bytes', 'stat-bytes'],
  ['lines', 'stat-lines'],
  ['paragraphs', 'stat-paragraphs'],
];

function render() {
  const stats = analyzeText($('stats-text').value);
  for (const [key, id] of NUMERIC_FIELDS) {
    $(id).textContent = stats[key].toLocaleString('zh-CN');
  }
  $('stat-reading').textContent = readingTimeText(stats.words);
  $('stat-breakdown').textContent = `含中文 ${stats.cjk.toLocaleString('zh-CN')} 字、英文 ${stats.latinWords.toLocaleString('zh-CN')} 词`;
}

$('stats-text').addEventListener('input', render);
wireFilePicker($('stats-file-button'), $('stats-file-input'), $('stats-text'), { onError: showError, onFile: render });
wireFileDrop($('stats-text'), { onError: showError, onFile: render });
render();
