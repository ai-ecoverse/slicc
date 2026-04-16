// Test 16: import path module
import path from 'path';
try {
  const joined = path.join('/foo', 'bar', 'baz.js');
  console.log('result:', joined === '/foo/bar/baz.js' ? 'PASS' : 'FAIL — got: ' + joined);
} catch (e) {
  console.log('result: FAIL —', e.message);
}
