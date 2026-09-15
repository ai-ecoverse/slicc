#!/usr/bin/env node
/**
 * Stand-in for `node-server --hosted`: records its argv + env, then writes
 * the join file (`SLICC_GW_JOIN_FILE`) after a short delay and idles until
 * SIGTERM. `FAKE_NODE_SERVER=exit` exits 2 immediately; `=never` never
 * writes the join file; `=stale` writes one dated before the boot.
 */
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_NODE_SERVER ?? 'ok';
console.log(`fake node-server argv=${JSON.stringify(process.argv.slice(2))}`);
console.log(
  `env PORT=${process.env.PORT} SECRETS=${process.env.SLICC_SECRETS_FILE} PROFILE=${process.env.CHROME_USER_DATA_DIR} INPUTS=${Object.keys(process.env).filter((k) => k.startsWith('INPUT_')).length}`
);
if (mode === 'exit') process.exit(2);
if (mode !== 'never') {
  setTimeout(() => {
    const updatedAt = mode === 'stale' ? new Date(Date.now() - 3_600_000) : new Date();
    writeFileSync(
      process.env.SLICC_GW_JOIN_FILE,
      JSON.stringify({
        joinUrl: 'https://www.sliccy.ai/join/fake.tray',
        trayId: 'fake-tray',
        sliccVersion: '0.0.0-fake',
        updatedAt: updatedAt.toISOString(),
      })
    );
  }, 150);
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
