export const MAX_SUDO_REASON_LENGTH = 300;

export function normalizeSudoReason(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_SUDO_REASON_LENGTH) return oneLine;

  const points = Array.from(oneLine);
  if (points.length <= MAX_SUDO_REASON_LENGTH) return oneLine;
  return `${points
    .slice(0, MAX_SUDO_REASON_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}
