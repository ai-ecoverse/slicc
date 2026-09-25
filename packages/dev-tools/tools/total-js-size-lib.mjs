import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function measureTotalJs(uiDir) {
  let bytes = 0;
  let files = 0;
  const dirs = [uiDir];
  while (dirs.length > 0) {
    const dir = dirs.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        bytes += statSync(path).size;
        files++;
      }
    }
  }
  if (files === 0) throw new Error(`no JS files in ${uiDir} — build the webapp first`);
  return { bytes, files };
}

export function checkTotalJsDelta(head, baseline, maxDeltaKb) {
  if (!Number.isFinite(maxDeltaKb) || maxDeltaKb < 0) {
    throw new Error('total-js-budget.json needs a non-negative maxDeltaKb');
  }
  if (!baseline) return { deltaKb: null, passed: true };
  const deltaKb = (head.bytes - baseline.bytes) / 1024;
  return { deltaKb, passed: deltaKb <= maxDeltaKb };
}
