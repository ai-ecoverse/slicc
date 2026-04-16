// Test 17: Buffer via shim
import { Buffer } from 'buffer';
try {
  const b = Buffer.from('hello');
  console.log('result:', b.toString() === 'hello' ? 'PASS' : 'FAIL');
} catch (e) {
  console.log('result: FAIL —', e.message);
}
