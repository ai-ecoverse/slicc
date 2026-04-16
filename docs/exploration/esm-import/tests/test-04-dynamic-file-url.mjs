// Test 04: Dynamic import with file:// URL
try {
  const m = await import('file:///slicc/findings/helper.mjs');
  console.log('result: PASS —', m.default);
} catch (e) {
  console.log('result: FAIL —', e.message);
}
