import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { base64Encode, base64Decode, urlEncode, urlDecode, timestampToDate, dateToTimestamp } from '../lib/codec-time.js';

const $ = id => document.getElementById(id);

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function guard(action) {
  showError('');
  try {
    action();
  } catch (error) {
    showError(error.message);
  }
}

$('b64-encode').addEventListener('click', () => guard(() => {
  $('b64-output').value = base64Encode($('b64-input').value);
}));
$('b64-decode').addEventListener('click', () => guard(() => {
  $('b64-output').value = base64Decode($('b64-input').value);
}));
$('url-encode').addEventListener('click', () => guard(() => {
  $('url-output').value = urlEncode($('url-input').value);
}));
$('url-decode').addEventListener('click', () => guard(() => {
  $('url-output').value = urlDecode($('url-input').value);
}));
$('ts-to-date').addEventListener('click', () => guard(() => {
  $('ts-output').value = timestampToDate($('ts-input').value.trim()).text;
}));
$('date-to-ts').addEventListener('click', () => guard(() => {
  const { seconds, milliseconds } = dateToTimestamp($('date-input').value);
  $('date-output').value = `${seconds} 秒 · ${milliseconds} 毫秒`;
}));

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
