// Registers the site-wide service worker for tool pages.
// Mirrors src/main.js:659-661 — keep the two in sync.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {}));
}
