document.addEventListener('error', (event) => {
  const img = event.target;
  if (img instanceof HTMLImageElement && !img.dataset.fallback) {
    img.dataset.fallback = '1';
    img.classList.add('image-fallback');
    img.src = 'img/placeholder.svg';
  }
}, true);
document.querySelectorAll('.toast').forEach(el => {el.setAttribute('role','status');el.setAttribute('aria-live','polite');});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') document.querySelector('.sheet.open [data-close-sheet]')?.click();
});
