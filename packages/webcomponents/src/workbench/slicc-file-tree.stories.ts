import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { FileTreeItem, SliccFileTree } from './slicc-file-tree.js';
import './slicc-file-tree.js';

interface FileTreeArgs {
  selected?: string;
}

/**
 * The prototype VFS sidebar contents, expressed the way the live workbench does.
 *
 * Every `id` is a full path because the tree derives its hierarchy from paths,
 * not from the nesting of the `children` arrays — a flat id like `hero.tsx`
 * would render at the root regardless of where it sits in this literal.
 * `group` rows are still accepted (they flatten away) so older producers keep
 * working.
 */
const PROTOTYPE_ITEMS: FileTreeItem[] = [
  { kind: 'group', label: 'workspace/' },
  {
    kind: 'dir',
    id: 'workspace/components',
    label: 'components',
    open: true,
    children: [
      {
        kind: 'file',
        id: 'workspace/components/hero.tsx',
        label: 'hero.tsx',
        path: 'workspace/components/hero.tsx',
        size: 3412,
      },
      {
        kind: 'file',
        id: 'workspace/components/hero.css',
        label: 'hero.css',
        path: 'workspace/components/hero.css',
        size: 1842,
      },
      {
        kind: 'dir',
        id: 'workspace/components/ui',
        label: 'ui',
        children: [
          {
            kind: 'file',
            id: 'workspace/components/ui/button.tsx',
            label: 'button.tsx',
            path: 'workspace/components/ui/button.tsx',
          },
          {
            kind: 'file',
            id: 'workspace/components/ui/icon-button.tsx',
            label: 'icon-button.tsx',
            path: 'workspace/components/ui/icon-button.tsx',
          },
        ],
      },
    ],
  },
  { kind: 'file', id: 'workspace/tokens.css', label: 'tokens.css', path: 'workspace/tokens.css' },
  { kind: 'file', id: 'workspace/nav.tsx', label: 'nav.tsx', path: 'workspace/nav.tsx' },
  { kind: 'group', label: 'skills/' },
  {
    kind: 'file',
    id: 'workspace/skills/sprinkles',
    label: 'sprinkles',
    path: 'workspace/skills/sprinkles',
  },
  {
    kind: 'dir',
    id: 'workspace/.mcp',
    label: '.mcp',
    children: [
      {
        kind: 'file',
        id: 'workspace/.mcp/servers.json',
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
export const ActiveFile: Story = { args: { selected: 'workspace/components/hero.css' } };

/**
 * Nested directories that fold/expand: `components/` is open (chevron rotated,
 * children indented), with a collapsed `ui/` inside it and a collapsed `.mcp`
 * below. Click a directory row to toggle it. The directory-style `sprinkles/`
 * file row stays selected, preserving the existing selection behavior.
 */
export const DirectorySelected: Story = { args: { selected: 'workspace/skills/sprinkles' } };

/**
 * Production VFS panel layout: `workspace` and `shared` are collapsible `dir`
 * items (open by default) rather than flat `group` headers. Files carry a `size`
 * field that renders as a dimmed badge on the right. This matches exactly what
 * `buildVfsTreeItems` produces in the live workbench.
 *
 * Click a chevron to collapse a root dir — the tree remembers the state across
 * re-renders (the `items` setter only seeds from `open:true` flags on the very
 * first assignment; subsequent refreshes leave user toggles untouched).
 */
export const VfsPanel: Story = {
  args: {},
  render: () => {
    const VFS_ITEMS: FileTreeItem[] = [
      {
        kind: 'dir',
        id: '/workspace',
        label: 'workspace',
        open: true,
        children: [
          {
            kind: 'dir',
            id: '/workspace/skills',
            label: 'skills',
            children: [
              {
                kind: 'file',
                id: '/workspace/skills/SKILL.md',
                label: 'SKILL.md',
                path: '/workspace/skills/SKILL.md',
                size: 4210,
              },
            ],
          },
          {
            kind: 'file',
            id: '/workspace/CLAUDE.md',
            label: 'CLAUDE.md',
            path: '/workspace/CLAUDE.md',
            size: 872,
          },
          {
            kind: 'file',
            id: '/workspace/tokens.css',
            label: 'tokens.css',
            path: '/workspace/tokens.css',
            size: 3412,
          },
        ],
      },
      {
        kind: 'dir',
        id: '/shared',
        label: 'shared',
        open: true,
        children: [
          {
            kind: 'dir',
            id: '/shared/sprinkles',
            label: 'sprinkles',
            children: [
              {
                kind: 'file',
                id: '/shared/sprinkles/welcome.shtml',
                label: 'welcome.shtml',
                path: '/shared/sprinkles/welcome.shtml',
                size: 1540,
              },
            ],
          },
          {
            kind: 'file',
            id: '/shared/CLAUDE.md',
            label: 'CLAUDE.md',
            path: '/shared/CLAUDE.md',
            size: 2980,
          },
        ],
      },
    ];

    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;align-items:stretch;height:320px;font-family:var(--ui);color:var(--ink);background:var(--canvas);';

    const tree = document.createElement('slicc-file-tree') as SliccFileTree;
    tree.style.cssText = 'width:100%;border-right:none;';
    tree.items = VFS_ITEMS;

    const status = document.createElement('div');
    status.style.cssText =
      'position:absolute;bottom:8px;left:50%;transform:translateX(-50%);font-size:11px;color:var(--txt-3);white-space:nowrap;';
    status.textContent = 'click a file to select · click a chevron to collapse';

    tree.addEventListener('file-select', (e) => {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      status.textContent = `selected: ${id}`;
    });
    tree.addEventListener('dir-toggle', (e) => {
      const { id, open } = (e as CustomEvent<{ id: string; open: boolean }>).detail;
      status.textContent = `${id} ${open ? 'expanded' : 'collapsed'}`;
    });

    wrap.style.position = 'relative';
    wrap.append(tree, status);
    return wrap;
  },
};

/**
 * Row actions, which now live in the context menu.
 *
 * The old tree drew four buttons (Preview, Reference, Download, Overflow) on
 * every file row on hover; `@pierre/trees` renders row decorations as text or an
 * icon only, so the actions moved to the row's context menu — reachable by
 * right-click or the trigger that appears on hover. The events are unchanged,
 * so what the host wires up did not move with them.
 */
export const RowActions: Story = {
  render: () => {
    const wrap = buildTree({ selected: 'workspace/components/hero.css' });
    const status = wrap.querySelector('div:last-child') as HTMLElement;
    const tree = wrap.querySelector('slicc-file-tree') as SliccFileTree;
    tree.addEventListener('file-preview', (e) => {
      status.textContent = `file-preview → ${(e as CustomEvent).detail.path}`;
    });
    tree.addEventListener('file-reference', (e) => {
      status.textContent = `file-reference → ${(e as CustomEvent).detail.path}`;
    });
    tree.addEventListener('file-download', (e) => {
      status.textContent = `file-download → ${(e as CustomEvent).detail.path}`;
    });
    tree.addEventListener('file-overflow', (e) => {
      status.textContent = `file-overflow → ${(e as CustomEvent).detail.path}`;
    });
    return wrap;
  },
  args: {},
};

/**
 * Git status lanes — a capability the hand-rolled tree never had.
 *
 * Assigning `gitStatus` paints per-row state (added / modified / deleted /
 * untracked) using the same tokens as the rest of the UI, so the tree flips with
 * the theme. Paths that carry no entry render unchanged.
 */
export const GitStatus: Story = {
  args: {},
  render: () => {
    const wrap = buildTree({});
    const tree = wrap.querySelector('slicc-file-tree') as SliccFileTree;
    tree.gitStatus = [
      { path: 'workspace/components/hero.tsx', status: 'modified' },
      { path: 'workspace/components/ui/button.tsx', status: 'added' },
      { path: 'workspace/tokens.css', status: 'untracked' },
      { path: 'workspace/nav.tsx', status: 'deleted' },
    ];
    return wrap;
  },
};

/**
 * Type-to-search, also new with the library: the tree filters as you type and
 * keeps the matches reachable from the keyboard.
 */
export const Search: Story = {
  args: {},
  render: () => {
    const wrap = buildTree({});
    const status = wrap.querySelector('div:last-child') as HTMLElement;
    status.textContent = 'focus a row and start typing to filter';
    return wrap;
  },
};
