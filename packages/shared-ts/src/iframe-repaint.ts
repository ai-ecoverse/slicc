interface FrameGlobal {
  self?: unknown;
  top?: unknown;
}

export function isNestedInAnotherFrame(): boolean {
  try {
    const win = (globalThis as { window?: FrameGlobal }).window ?? (globalThis as FrameGlobal);
    return win.self !== win.top;
  } catch {
    return true;
  }
}

interface RepaintableIframe {
  style: { display: string };
  isConnected: boolean;
}

const nudgeInFlight = new WeakSet<RepaintableIframe>();

type RequestAnimationFrameFn = (callback: (time: number) => void) => number;

export function nudgeIframeRepaint(iframe: RepaintableIframe, onDone?: () => void): void {
  if (nudgeInFlight.has(iframe)) {
    onDone?.();
    return;
  }

  let rafRestored = false;
  performNudge(iframe, onDone, () => {
    rafRestored = true;
  });

  setTimeout(() => {
    if (rafRestored) return;
    if (!iframe.isConnected) return;
    performNudge(iframe);
  }, 500);
}

function performNudge(
  iframe: RepaintableIframe,
  onDone?: () => void,
  onRafRestore?: () => void
): void {
  if (nudgeInFlight.has(iframe)) {
    onDone?.();
    return;
  }
  nudgeInFlight.add(iframe);
  const previousDisplay = iframe.style.display;
  iframe.style.display = 'none';

  let restored = false;
  const restore = (viaRaf: boolean) => {
    if (restored) return;
    restored = true;
    iframe.style.display = previousDisplay;
    nudgeInFlight.delete(iframe);
    if (viaRaf) onRafRestore?.();
    onDone?.();
  };

  const raf = (globalThis as { requestAnimationFrame?: RequestAnimationFrameFn })
    .requestAnimationFrame;
  if (typeof raf === 'function') {
    raf(() => {
      raf(() => restore(true));
    });
  }
  setTimeout(() => restore(false), 100);
}
