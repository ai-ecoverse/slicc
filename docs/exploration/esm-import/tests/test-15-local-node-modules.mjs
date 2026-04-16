// Test 15: import from local node_modules (not esm.sh)
// @adobe/rum-distiller exists at /workspace/skills/query/scripts/node_modules/@adobe/rum-distiller
import { DataChunks } from '@adobe/rum-distiller';
try {
  const dc = new DataChunks();
  console.log('result: PASS — DataChunks instance:', typeof dc);
} catch (e) {
  console.log('result: FAIL —', e.message);
}
