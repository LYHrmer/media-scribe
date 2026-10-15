// Shared "pick a local text file into a textarea" wiring for tool pages.
// Elements (not ids) are passed in so each page keeps owning its DOM lookup.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function wireFilePicker(button, input, textarea, { onError, onFile } = {}) {
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = ''; // re-picking the same file must fire change again
    if (!file) return;
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
  });
}

// 'demo.srt' -> 'demo'; '' -> fallback
export function fileBaseName(name, fallback) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  return base || fallback;
}
