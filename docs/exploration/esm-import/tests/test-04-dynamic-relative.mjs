// Test 04: Dynamic import with relative path
try {
  const m = await import('./test-helper.mjs');
  console.log('result:', m.value === 'hello' ? 'PASS' : 'FAIL');
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
