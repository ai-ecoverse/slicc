// Test 17: env vars set inline before node command
console.log('result:', process.env.TEST_VAR ? 'PASS' : 'FAIL');
console.log('TEST_VAR:', process.env.TEST_VAR ?? '(not set)');
