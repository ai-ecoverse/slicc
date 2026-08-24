import { describe, expect, it } from 'vitest';
import { GLOBAL_NODE_MODULES } from '../../../src/shell/ipk/global-prefix.js';
import { nodeModulesSearchPath } from '../../../src/shell/ipk/resolver.js';

describe('global ipk prefix', () => {
  it('nodeModulesSearchPath appends the global tree after local ancestors', () => {
    const dirs = nodeModulesSearchPath('/work/project');
    expect(dirs[0]).toBe('/work/project/node_modules');
    expect(dirs[dirs.length - 1]).toBe(GLOBAL_NODE_MODULES);
    expect(dirs.filter((d) => d === GLOBAL_NODE_MODULES)).toHaveLength(1);
  });
});
