import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { renderMarkdown } from '../lib/markdown-lite.js';
import { wireFilePicker, wireFileDrop } from '../lib/file-picker.js';

const $ = id => document.getElementById(id);

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function render() {
  // Safe by construction: renderMarkdown escapes all user text first and only
  // injects its own tags with an allowlisted URL scheme.
  $('md-preview').innerHTML = renderMarkdown($('md-input').value);
}

$('md-input').addEventListener('input', render);
wireFilePicker($('md-file-button'), $('md-file-input'), $('md-input'), { onError: showError, onFile: render });
wireFileDrop($('md-input'), { onError: showError, onFile: render });
render();
