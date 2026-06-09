import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { FileTreeItem, SliccFileTree } from './slicc-file-tree.js';
import './slicc-file-tree.js';

interface FileTreeArgs {
  selected?: string;
}

/** The prototype VFS sidebar contents (`workspace/` + `skills/` groups). */
const PROTOTYPE_ITEMS: FileTreeItem[] = [
  { kind: 'group', label: 'workspace/' },
  { kind: 'file', id: 'hero.tsx', label: 'hero.tsx', path: 'workspace/hero.tsx' },
  { kind: 'file', id: 'hero.css', label: 'hero.css', path: 'workspace/hero.css' },
  { kind: 'file', id: 'tokens.css', label: 'tokens.css', path: 'workspace/tokens.css' },
  { kind: 'file', id: 'nav.tsx', label: 'nav.tsx', path: 'workspace/nav.tsx' },
  { kind: 'group', label: 'skills/' },
  { kind: 'file', id: 'sprinkles/', label: 'sprinkles/', path: 'workspace/skills/sprinkles/' },
  { kind: 'file', id: '.mcp/', label: '.mcp/', path: 'workspace/.mcp/' },
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

/** A nested-directory selection (folder-style file rows). */
export const DirectorySelected: Story = { args: { selected: 'sprinkles/' } };
