let activeOverlay: HTMLElement | null = null;
let activeCleanup: (() => void) | null = null;

export function showImagePreview(src: string, originEl: HTMLElement): () => void {
  if (activeOverlay) {
    dismissImmediate();
  }

  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';

  const backdrop = document.createElement('div');
  backdrop.className = 'image-preview-backdrop';
  overlay.appendChild(backdrop);

  const img = document.createElement('img');
  img.className = 'image-preview-image';
  img.src = src;
  img.alt = 'Image preview';
  overlay.appendChild(img);

  document.body.appendChild(overlay);
  activeOverlay = overlay;

  const originRect = originEl.getBoundingClientRect();

  const animateOpen = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxW = vw * 0.9;
    const maxH = vh * 0.9;

    const natW = img.naturalWidth || originRect.width * 4;
    const natH = img.naturalHeight || originRect.height * 4;
    const scale = Math.min(maxW / natW, maxH / natH, 1);
    const finalW = natW * scale;
    const finalH = natH * scale;

    const finalLeft = (vw - finalW) / 2;
    const finalTop = (vh - finalH) / 2;

    // Position image at final size and location using CSS positioning
    img.style.position = 'absolute';
    img.style.width = `${finalW}px`;
    img.style.height = `${finalH}px`;
    img.style.left = `${finalLeft}px`;
    img.style.top = `${finalTop}px`;
    img.style.borderRadius = '6px';

    // Calculate transform to start from the origin thumbnail
    const scaleX = originRect.width / finalW;
    const scaleY = originRect.height / finalH;
    const originCenterX = originRect.left + originRect.width / 2;
    const originCenterY = originRect.top + originRect.height / 2;
    const finalCenterX = finalLeft + finalW / 2;
    const finalCenterY = finalTop + finalH / 2;
    const translateX = originCenterX - finalCenterX;
    const translateY = originCenterY - finalCenterY;

    // Start at thumbnail position/size
    img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
    img.style.borderRadius = `${6 / Math.min(scaleX, scaleY)}px`;

    // Trigger reflow then animate to final position
    img.offsetHeight; // eslint-disable-line @typescript-eslint/no-unused-expressions
    img.style.transform = 'translate(0, 0) scale(1, 1)';
    img.style.borderRadius = '6px';

    overlay.classList.add('image-preview-overlay--visible');
  };

  if (img.complete && img.naturalWidth > 0) {
    requestAnimationFrame(animateOpen);
  } else {
    img.onload = () => requestAnimationFrame(animateOpen);
    img.onerror = () => {
      overlay.remove();
      activeOverlay = null;
    };
  }

  let dismissed = false;

  const dismiss = () => {
    if (dismissed || !activeOverlay || overlay !== activeOverlay) return;
    dismissed = true;

    overlay.classList.add('image-preview-overlay--closing');
    overlay.classList.remove('image-preview-overlay--visible');

    // Animate back to origin if it's still in the DOM
    const currentOriginRect = originEl.getBoundingClientRect();
    if (currentOriginRect.width > 0 && currentOriginRect.height > 0) {
      const imgRect = img.getBoundingClientRect();
      const scaleX = currentOriginRect.width / imgRect.width;
      const scaleY = currentOriginRect.height / imgRect.height;
      const originCenterX = currentOriginRect.left + currentOriginRect.width / 2;
      const originCenterY = currentOriginRect.top + currentOriginRect.height / 2;
      const imgCenterX = imgRect.left + imgRect.width / 2;
      const imgCenterY = imgRect.top + imgRect.height / 2;
      const translateX = originCenterX - imgCenterX;
      const translateY = originCenterY - imgCenterY;

      img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
      img.style.borderRadius = `${6 / Math.min(scaleX, scaleY)}px`;
    }

    const cleanup = () => {
      overlay.remove();
      if (activeOverlay === overlay) {
        activeOverlay = null;
      }
      if (activeCleanup) {
        activeCleanup();
        activeCleanup = null;
      }
    };
    const timeout = setTimeout(cleanup, 400);
    overlay.addEventListener(
      'transitionend',
      () => {
        clearTimeout(timeout);
        cleanup();
      },
      { once: true }
    );
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };
  overlay.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);

  activeCleanup = () => {
    document.removeEventListener('keydown', onKey);
  };

  return dismiss;
}

function dismissImmediate(): void {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
}
