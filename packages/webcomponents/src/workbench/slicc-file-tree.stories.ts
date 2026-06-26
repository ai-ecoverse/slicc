import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { FileTreeItem, SliccFileTree } from './slicc-file-tree.js';
import './slicc-file-tree.js';

interface FileTreeArgs {
  selected?: string;
}

/**
 * The prototype VFS sidebar contents (`workspace/` + `skills/` groups), now with
 * nested foldable directories (`dir`) demonstrating fold/expand. `components/` is
 * seeded open and itself nests a collapsed `ui/`; the `skills/` group keeps the
 * selectable directory-style file rows from the prototype alongside a foldable
 * `.mcp` directory.
 */
const PROTOTYPE_ITEMS: FileTreeItem[] = [
  { kind: 'group', label: 'workspace/' },
  {
    kind: 'dir',
    id: 'components',
    label: 'components',
    open: true,
    children: [
      {
        kind: 'file',
        id: 'hero.tsx',
        label: 'hero.tsx',
        path: 'workspace/components/hero.tsx',
        size: 3412,
      },
      {
        kind: 'file',
        id: 'hero.css',
        label: 'hero.css',
        path: 'workspace/components/hero.css',
        size: 1842,
      },
      {
        kind: 'dir',
        id: 'ui',
        label: 'ui',
        children: [
          {
            kind: 'file',
            id: 'button.tsx',
            label: 'button.tsx',
            path: 'workspace/components/ui/button.tsx',
          },
          {
            kind: 'file',
            id: 'icon-button.tsx',
            label: 'icon-button.tsx',
            path: 'workspace/components/ui/icon-button.tsx',
          },
        ],
      },
    ],
  },
  { kind: 'file', id: 'tokens.css', label: 'tokens.css', path: 'workspace/tokens.css' },
  { kind: 'file', id: 'nav.tsx', label: 'nav.tsx', path: 'workspace/nav.tsx' },
  { kind: 'group', label: 'skills/' },
  { kind: 'file', id: 'sprinkles/', label: 'sprinkles/', path: 'workspace/skills/sprinkles/' },
  {
    kind: 'dir',
    id: 'mcp',
    label: '.mcp',
    children: [
      {
        kind: 'file',
        id: 'servers.json',
        label: 'servers.json',
        path: 'workspace/.mcp/servers.json',
      },
    ],
  },
];

/**
 * Build a populated tree wired to a live status line so the `file-select`
 * event and single-selection behavior are reviewable in the story.
 */
function buildTree(args: FileTreeArgs): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;align-items:stretch;height:280px;font-family:var(--ui);color:var(--ink);background:var(--canvas);';

  const tree = document.createElement('slicc-file-tree') as SliccFileTree;
  tree.items = PROTOTYPE_ITEMS;
  if (args.selected) tree.selected = args.selected;

  const panel = document.createElement('div');
  panel.style.cssText =
    'flex:1;padding:14px 16px;font-size:12.5px;line-height:1.7;color:var(--txt-2);';
  panel.textContent = args.selected ? `selected: ${args.selected}` : 'select a file from the tree…';

  tree.addEventListener('file-select', (e) => {
    const detail = (e as CustomEvent<{ id: string; path: string }>).detail;
    panel.textContent = `file-select → id: ${detail.id} · path: ${detail.path}`;
  });

  wrap.append(tree, panel);
  return wrap;
}

const meta: Meta<FileTreeArgs> = {
  title: 'Workbench/FileTree',
  component: 'slicc-file-tree',
  tags: ['autodocs'],
  argTypes: {
    selected: { control: 'text', description: 'Id of the active file row' },
  },
  render: (args) => buildTree(args),
};

export default meta;
type Story = StoryObj<FileTreeArgs>;

/** Idle — no file selected; group headers and file rows at rest. */
export const Default: Story = { args: {} };

/** The prototype state: `hero.css` selected (violet `.f.on` tint). */
export const ActiveFile: Story = { args: { selected: 'hero.css' } };

/**
 * Nested directories that fold/expand: `components/` is open (chevron rotated,
 * children indented), with a collapsed `ui/` inside it and a collapsed `.mcp`
 * below. Click a directory row to toggle it. The directory-style `sprinkles/`
 * file row stays selected, preserving the existing selection behavior.
 */
export const DirectorySelected: Story = { args: { selected: 'sprinkles/' } };
