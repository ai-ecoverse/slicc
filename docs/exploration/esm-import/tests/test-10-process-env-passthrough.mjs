// Test 10: env var set in shell passed through to process.env in .mjs
console.log('result:', process.env.DOMAINKEY_FILE ? 'PASS' : 'FAIL');
console.log('DOMAINKEY_FILE:', process.env.DOMAINKEY_FILE ?? '(not set)');
