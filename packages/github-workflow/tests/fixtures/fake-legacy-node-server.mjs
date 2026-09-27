#!/usr/bin/env node
/**
 * Stand-in for a published node-server: writes only the historical join path
 * (`SLICC_GW_LEGACY_JOIN_FILE`) and ignores a per-leader path. The source
 * must not mention the per-leader env name, or start-leader treats it as new.
 */
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_NODE_SERVER ?? 'ok';
const perLeader = ['SLICC', 'JOIN', 'FILE'].join('_');
console.log(`legacy fake argv=${JSON.stringify(process.argv.slice(2))}`);
console.log(`per-leader-env=${process.env[perLeader] ? 1 : 0}`);
if (mode === 'exit') process.exit(2);
if (mode !== 'never') {
  setTimeout(() => {
    const updatedAt = mode === 'stale' ? new Date(Date.now() - 3_600_000) : new Date();
    writeFileSync(
      process.env.SLICC_GW_LEGACY_JOIN_FILE,
      JSON.stringify({
        joinUrl: process.env.FAKE_JOIN_URL || 'https://www.sliccy.ai/join/fake.tray',
        trayId: 'legacy-tray',
        sliccVersion: '0.0.0-legacy',
        updatedAt: updatedAt.toISOString(),
      })
    );
  }, 150);
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
