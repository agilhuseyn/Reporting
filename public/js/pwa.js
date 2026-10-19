// Service worker qeydiyyatı (quraşdırma üçün lazımdır)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
