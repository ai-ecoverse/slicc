import type { VirtualFS } from '../fs/virtual-fs.js';
import type { BlockInventoryEntry } from './types.js';

export async function scanBlockInventory(
  fs: VirtualFS,
  projectPath: string,
): Promise<BlockInventoryEntry[]> {
  const blocksDir = `${projectPath}/blocks`;
  const entries: BlockInventoryEntry[] = [];

  let dirEntries;
  try {
    dirEntries = await fs.readDir(blocksDir);
  } catch {
    return entries;
  }

  for (const entry of dirEntries) {
    if (entry.type !== 'directory') continue;

    const name = entry.name;
    const blockDir = `${blocksDir}/${name}`;

    let files;
    try {
      files = await fs.readDir(blockDir);
    } catch {
      continue;
    }

    const hasJs = files.some((f) => f.name === `${name}.js`);
    const hasCss = files.some((f) => f.name === `${name}.css`);

    if (!hasJs && !hasCss) continue;

    let jsSize: number | undefined;
    let cssSize: number | undefined;

    if (hasJs) {
      const content = await fs.readFile(
        `${blockDir}/${name}.js`,
        { encoding: 'utf-8' },
      );
      jsSize = typeof content === 'string'
        ? content.length
        : content.byteLength;
    }

    if (hasCss) {
      const content = await fs.readFile(
        `${blockDir}/${name}.css`,
        { encoding: 'utf-8' },
      );
      cssSize = typeof content === 'string'
        ? content.length
        : content.byteLength;
    }

    entries.push({ name, hasJs, hasCss, jsSize, cssSize });
  }

  return entries;
}
