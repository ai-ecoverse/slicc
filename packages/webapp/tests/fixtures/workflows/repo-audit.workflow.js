export const meta = {
  name: 'repo-audit',
  description: 'Fan out finders, verify each finding',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
};
const FILES = args?.files || ['a.ts', 'b.ts'];
const BUGS = {
  type: 'object',
  properties: { bugs: { type: 'array', items: { type: 'string' } } },
  required: ['bugs'],
};
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] };
phase('Find');
const found = await pipeline(
  FILES,
  (file) => agent(`Find bugs in ${file}`, { phase: 'Find', schema: BUGS }),
  (res, file) =>
    parallel(
      (res?.bugs || []).map(
        (b) => () =>
          agent(`Verify "${b}" in ${file}`, { phase: 'Verify', schema: VERDICT }).then((v) => ({
            file,
            bug: b,
            real: !!v?.real,
          }))
      )
    )
);
const confirmed = found
  .flat()
  .filter(Boolean)
  .filter((x) => x.real);
log(`confirmed ${confirmed.length}`);
return { confirmed };
