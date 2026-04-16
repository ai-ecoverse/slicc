// Test 11: Static import of a scoped npm package (@adobe/rum-distiller)
import { DataChunks } from '@adobe/rum-distiller';
console.log('result:', typeof DataChunks === 'function' ? 'PASS' : 'FAIL');
console.log('DataChunks:', typeof DataChunks);
