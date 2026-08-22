(() => {
  document.querySelectorAll('[data-before-after]').forEach(comparison => {
    const control = comparison.querySelector('input[type="range"]');
    if (!control) return;
    const update = () => {
      const value = Math.min(100, Math.max(0, Number(control.value) || 0));
      comparison.style.setProperty('--split', `${value}%`);
      control.setAttribute('aria-valuetext', `${value}% zdjęcia przed`);
    };
    control.addEventListener('input', update);
    update();
  });

  const dialog = document.getElementById('caseLightbox');
  const galleryLinks = [...document.querySelectorAll('.gallery a')];
  if (!dialog || !galleryLinks.length || typeof dialog.showModal !== 'function') return;

  const media = dialog.querySelector('[data-lightbox-media]');
  const caption = dialog.querySelector('[data-lightbox-caption]');
  const counter = dialog.querySelector('[data-lightbox-counter]');
  const previous = dialog.querySelector('[data-lightbox-previous]');
  const next = dialog.querySelector('[data-lightbox-next]');
  const close = dialog.querySelector('[data-lightbox-close]');
  let index = 0;
  let trigger = null;
  let image = null;

  function ensureImage() {
    if (image) return;
    image = document.createElement('img');
    image.decoding = 'async';
    media.append(image);
  }

  function show(selected) {
    ensureImage();
    index = selected;
    const link = galleryLinks[index];
    const thumbnail = link.querySelector('img');
    image.src = link.href;
    image.alt = thumbnail?.alt || '';
    caption.textContent = image.alt;
    counter.textContent = `Zdjęcie ${index + 1} z ${galleryLinks.length}`;
    previous.disabled = index === 0;
    next.disabled = index === galleryLinks.length - 1;
  }

  function step(change) {
    const selected = index + change;
    if (selected >= 0 && selected < galleryLinks.length) show(selected);
  }

  galleryLinks.forEach((link, selected) => {
    link.addEventListener('click', event => {
      event.preventDefault();
      trigger = link;
      show(selected);
      dialog.showModal();
      close.focus();
    });
  });

  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    }
  });
  dialog.addEventListener('close', () => {
    trigger?.focus();
    trigger = null;
  });
})();
