import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { convertLines } from '../lib/ts-batch.js';
import { wireFilePicker, wireFileDrop } from '../lib/file-picker.js';

const $ = id => document.getElementById(id);

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

$('convert-button').addEventListener('click', () => {
  $('batch-output').value = convertLines($('batch-input').value);
});

wireFilePicker($('batch-file-button'), $('batch-file-input'), $('batch-input'), { onError: showError });
wireFileDrop($('batch-input'), { onError: showError });

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
