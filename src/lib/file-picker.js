// Shared "local text file into a textarea" wiring for tool pages, in both
// flavors: a picker button and drag-and-drop onto the textarea itself.
// Elements (not ids) are passed in so each page keeps owning its DOM lookup.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function loadFileInto(file, textarea, { onError, onFile } = {}) {
  if (file.size > MAX_FILE_BYTES) {
    onError?.(`文件 ${file.name} 超过 10 MB，请先在编辑器里拆分`);
    return;
  }
  try {
    textarea.value = await file.text();
    onError?.('');
    onFile?.(file.name);
  } catch {
    onError?.(`无法读取文件 ${file.name}`);
  }
}

export function wireFilePicker(button, input, textarea, handlers = {}) {
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = ''; // re-picking the same file must fire change again
    if (file) loadFileInto(file, textarea, handlers);
  });
}

export function wireFileDrop(textarea, handlers = {}) {
  textarea.addEventListener('dragover', event => {
    event.preventDefault();
    textarea.classList.add('tool-drop-active');
  });
  textarea.addEventListener('dragleave', () => textarea.classList.remove('tool-drop-active'));
  textarea.addEventListener('drop', event => {
    event.preventDefault();
    textarea.classList.remove('tool-drop-active');
    const file = event.dataTransfer.files[0];
    if (file) loadFileInto(file, textarea, handlers);
  });
}

// 'demo.srt' -> 'demo'; '' -> fallback
export function fileBaseName(name, fallback) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  return base || fallback;
}
