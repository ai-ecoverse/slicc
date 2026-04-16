// Test 09: import process from shim
import process from 'process';
try {
  console.log('result: PASS — process.env is', typeof process.env);
} catch (e) {
  console.log('result: FAIL —', e.message);
}
