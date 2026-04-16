// Test 05: Dynamic import with file:// URL
try {
  const m = await import('file:///slicc/findings/test-helper.mjs');
  console.log('result:', m.value === 'hello' ? 'PASS' : 'FAIL');
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
