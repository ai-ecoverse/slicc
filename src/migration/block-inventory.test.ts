import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/virtual-fs.js';
import { scanBlockInventory } from './block-inventory.js';

describe('scanBlockInventory', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-block-inventory-${dbCounter++}`,
      wipe: true,
    });
  });

  it('returns empty array when blocks/ does not exist', async () => {
    const result = await scanBlockInventory(vfs, '/project');
    expect(result).toEqual([]);
  });

  it('scans block directories for JS and CSS files', async () => {
    await vfs.mkdir('/project/blocks/header', { recursive: true });
    await vfs.writeFile('/project/blocks/header/header.js', 'export default {};');
    await vfs.writeFile('/project/blocks/header/header.css', '.header { color: red; }');

    await vfs.mkdir('/project/blocks/footer', { recursive: true });
    await vfs.writeFile('/project/blocks/footer/footer.js', 'console.log("footer");');

    const result = await scanBlockInventory(vfs, '/project');
    const sorted = result.sort((a, b) => a.name.localeCompare(b.name));

    expect(sorted).toHaveLength(2);

    expect(sorted[0]).toMatchObject({
      name: 'footer',
      hasJs: true,
      hasCss: false,
    });
    expect(sorted[0]!.jsSize).toBeDefined();
    expect(sorted[0]!.cssSize).toBeUndefined();

    expect(sorted[1]).toMatchObject({
      name: 'header',
      hasJs: true,
      hasCss: true,
    });
    expect(sorted[1]!.jsSize).toBeDefined();
    expect(sorted[1]!.cssSize).toBeDefined();
  });

  it('ignores non-block files (README.md, .DS_Store)', async () => {
    await vfs.mkdir('/project/blocks/hero', { recursive: true });
    await vfs.writeFile('/project/blocks/hero/hero.js', 'var x = 1;');
    await vfs.writeFile('/project/blocks/README.md', '# Blocks');
    await vfs.writeFile('/project/blocks/.DS_Store', '');

    const result = await scanBlockInventory(vfs, '/project');

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('hero');
  });

  it('reports correct file sizes', async () => {
    const jsContent = 'const x = 42;';
    const cssContent = '.block { display: flex; }';

    await vfs.mkdir('/project/blocks/card', { recursive: true });
    await vfs.writeFile('/project/blocks/card/card.js', jsContent);
    await vfs.writeFile('/project/blocks/card/card.css', cssContent);

    const result = await scanBlockInventory(vfs, '/project');

    expect(result).toHaveLength(1);
    expect(result[0]!.jsSize).toBe(jsContent.length);
    expect(result[0]!.cssSize).toBe(cssContent.length);
  });

  it('ignores directories without matching JS or CSS files', async () => {
    await vfs.mkdir('/project/blocks/empty', { recursive: true });
    await vfs.writeFile('/project/blocks/empty/other.txt', 'not a block');

    await vfs.mkdir('/project/blocks/misnamed', { recursive: true });
    await vfs.writeFile(
      '/project/blocks/misnamed/wrong-name.js',
      'export {};',
    );

    const result = await scanBlockInventory(vfs, '/project');
    expect(result).toEqual([]);
  });
});
