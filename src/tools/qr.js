import '../styles.css';
import '../toolbox.css';
import '../lib/register-sw.js';
import { encodeQr } from '../lib/qr-code.js';

const $ = id => document.getElementById(id);
const QUIET = 4; // quiet-zone modules on each side, per spec

function showError(message) {
  const el = $('tool-error');
  el.textContent = message || '';
  el.hidden = !message;
}

function draw() {
  showError('');
  const text = $('qr-input').value;
  const canvas = $('qr-canvas');
  const status = $('qr-status');
  if (!text) {
    canvas.hidden = true;
    status.hidden = true;
    $('qr-download').disabled = true;
    return;
  }
  let result;
  try {
    result = encodeQr(text, { ecl: $('qr-ecl').value });
  } catch (error) {
    showError(error.message);
    canvas.hidden = true;
    status.hidden = true;
    $('qr-download').disabled = true;
    return;
  }
  const { size, modules } = result;
  const scale = Math.max(2, Math.floor(320 / (size + QUIET * 2)));
  canvas.width = (size + QUIET * 2) * scale;
  canvas.height = canvas.width;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1a2b23';
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r * size + c]) ctx.fillRect((c + QUIET) * scale, (r + QUIET) * scale, scale, scale);
    }
  }
  canvas.hidden = false;
  status.textContent = `版本 ${result.version} · ${size}×${size} · 纠错 ${result.ecl} · 掩码 ${result.mask}`;
  status.hidden = false;
  $('qr-download').disabled = false;
}

$('qr-input').addEventListener('input', draw);
$('qr-ecl').addEventListener('change', draw);

$('qr-download').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = $('qr-canvas').toDataURL('image/png');
  link.download = '二维码.png';
  link.click();
});
