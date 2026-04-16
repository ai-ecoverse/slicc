// Test 05: Dynamic import with relative path
try {
  const m = await import('./helper.mjs');
  console.log('result: PASS —', m.default);
} catch (e) {
  console.log('result: FAIL —', e.message);
}
