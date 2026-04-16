import * as esbuild from 'esbuild';

const result = await esbuild.build({
  stdin: {
    contents: `import { parse } from 'dotenv'; console.log(parse('FOO=bar'));`,
    resolveDir: '/slicc/findings',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});

console.log('result:', result.outputFiles ? 'PASS' : 'FAIL');
console.log('output length:', result.outputFiles?.[0]?.text?.length);
console.log('snippet:', result.outputFiles?.[0]?.text?.slice(0, 200));
