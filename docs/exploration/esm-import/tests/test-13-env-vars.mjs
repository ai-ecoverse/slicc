// Test 13: env vars passed via shell are accessible via process shim
import process from 'process';
const val = process.env.TEST_VAR;
console.log('result:', val === 'hello123' ? 'PASS' : 'FAIL — got: ' + val);
