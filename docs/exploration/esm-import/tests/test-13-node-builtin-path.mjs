// Test 13: Static import of node built-in 'path'
import path from 'path';
try {
  const joined = path.join('/foo', 'bar', 'baz.js');
  console.log('result:', joined === '/foo/bar/baz.js' ? 'PASS' : 'FAIL');
  console.log('joined:', joined);
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
