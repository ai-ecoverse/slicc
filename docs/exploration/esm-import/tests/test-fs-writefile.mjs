import fs from 'fs';

try {
  await fs.writeFile('/slicc/findings/test-write-output.txt', 'hello from writeFile');
  console.log('result: PASS');
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
