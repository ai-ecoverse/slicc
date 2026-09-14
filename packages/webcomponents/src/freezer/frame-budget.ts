export const AMBIENT_FPS = 15;
export const AMBIENT_FRAME_MS = 1000 / AMBIENT_FPS;

export const BURST_MS = 800;

export const FRAME_EPSILON_MS = 4;

export function shouldRender(nowTs: number, lastFrameTs: number, energetic: boolean): boolean {
  if (energetic) return true;
  return nowTs - lastFrameTs >= AMBIENT_FRAME_MS - FRAME_EPSILON_MS;
}

export function advanceFrameTs(nowTs: number, lastFrameTs: number, energetic: boolean): number {
  if (energetic || !Number.isFinite(lastFrameTs)) return nowTs;
  const gridNext = lastFrameTs + AMBIENT_FRAME_MS;
  return nowTs - gridNext > AMBIENT_FRAME_MS ? nowTs : gridNext;
}
