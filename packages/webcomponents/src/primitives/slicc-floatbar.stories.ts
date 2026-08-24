import type { Meta, StoryObj } from '@storybook/web-components-vite';
import {
  connectionLabel,
  defaultFloatLabel,
  FLOATBAR_CONNECTIONS,
  FLOATBAR_FLOAT_KINDS,
  type FloatbarConnection,
  type FloatbarFloatKind,
  type FloatbarTrayRole,
  floatKindLabel,
  trayRoleLabel,
} from './floatbar-status.js';
import type { SliccFloatbar } from './slicc-floatbar.js';
import type { FollowerHudRow } from './slicc-follower-hud.js';
import './slicc-floatbar.js';
import '../nav/slicc-nav.js';

interface FloatbarArgs {
  label?: string;
  linked?: boolean;
  online?: boolean;
  connection?: FloatbarConnection;
  floatKind?: FloatbarFloatKind;
  trayRole?: FloatbarTrayRole;
  rate?: string;
  spent?: string;
  followerCount?: number;
}

function sampleFollowers(count: number): FollowerHudRow[] {
  const kinds: FollowerHudRow[] = [
    {
      id: 'follower-ext1',
      icon: 'blocks',
      title: 'Extension · 5b4a3928…',
      detail: 'slicc-extension',
      state: 'active',
      stateText: 'connected 4m',
    },
    {
      id: 'follower-cli1',
      icon: 'terminal',
      title: 'CLI · build-box',
      detail: 'lars@build-box',
      state: 'active',
      stateText: 'connected 2h',
      chips: ['can run commands'],
    },
    {
      id: 'follower-tab1',
      icon: 'monitor',
      title: 'Standalone · 9f8e7d6c…',
      detail: 'slicc-standalone',
      state: 'active',
      stateText: 'connected 31s',
      chips: ['hosts tabs'],
    },
  ];
  return kinds.slice(0, Math.max(0, count));
}

function mountFloatbar(args: FloatbarArgs): SliccFloatbar {
  const el = document.createElement('slicc-floatbar') as SliccFloatbar;
  if (args.label != null) el.label = args.label;
  if (args.linked) el.linked = true;
  if (args.connection != null) el.connection = args.connection;
  if (args.floatKind != null) el.floatKind = args.floatKind;
  if (args.trayRole != null) el.trayRole = args.trayRole;
  if (args.online) el.online = true;
  if (args.rate != null && args.rate !== '') el.rate = args.rate;
  if (args.spent != null && args.spent !== '') el.spent = args.spent;
  if (args.followerCount != null && args.followerCount > 0) {
    el.followers = sampleFollowers(args.followerCount);
  }
  return el;
}

function navRow(floatbar: SliccFloatbar): HTMLElement {
  const nav = document.createElement('slicc-nav');
  nav.style.cssText = 'width:min(720px, 100vw);padding:8px 12px;';
  nav.appendChild(floatbar);
  return nav;
}

function legend(): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText =
    'font:11px/1.45 var(--ui, system-ui);color:var(--txt-2,#666);max-width:720px;margin:0 0 16px;';
  box.textContent =
    'Left beacon: ring color = connection health · center icon = float kind · corner pip = leader (crown) or follower (radio). Follower count lives only in the middle segment — never in the label.';
  return box;
}

function cellCaption(parts: string[]): HTMLElement {
  const cap = document.createElement('div');
  cap.style.cssText = 'font:10px/1.3 var(--ui,system-ui);color:var(--txt-2,#666);margin-top:6px;';
  cap.textContent = parts.join(' · ');
  return cap;
}

const meta: Meta<FloatbarArgs> = {
  title: 'Primitives/Floatbar',
  component: 'slicc-floatbar',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Float name only (no tray/follower encoding)' },
    linked: { control: 'boolean', description: 'Rose-tinted border (legacy linked runtime)' },
    online: {
      control: 'boolean',
      description: 'Legacy: maps to live/offline when connection unset',
    },
    connection: {
      control: 'select',
      options: FLOATBAR_CONNECTIONS,
      description: 'Tray link health (beacon ring color)',
    },
    floatKind: {
      control: 'select',
      options: FLOATBAR_FLOAT_KINDS,
      description: 'Serving float (beacon center icon)',
    },
    trayRole: {
      control: 'select',
      options: ['none', 'leader', 'follower'],
      description: 'Tray role (beacon corner pip)',
    },
    rate: { control: 'text', description: 'Hourly burn rate' },
    spent: { control: 'text', description: 'Cumulative cost (overlay total)' },
    followerCount: {
      control: { type: 'number', min: 0, max: 3 },
      description: 'Middle segment count',
    },
  },
  render: (args) => navRow(mountFloatbar(args)),
};

export default meta;
type Story = StoryObj<FloatbarArgs>;

/** Local float — offline, no tray role. */
export const Default: Story = {
  args: { label: 'standalone', floatKind: 'standalone', connection: 'offline' },
};

/** Legacy `online` still lights the beacon (live + standalone icon). */
export const LegacyOnline: Story = {
  args: { label: 'npx', online: true },
};

/** Leader on npx with two followers — label stays float kind; count is in the middle. */
export const LeaderNpxWithFollowers: Story = {
  args: {
    label: 'npx',
    floatKind: 'npx',
    connection: 'live',
    trayRole: 'leader',
    followerCount: 2,
    rate: '23.10',
    spent: '18.42',
  },
};

/** Same follower count on a different float kind — orthogonal. */
export const LeaderExtensionWithFollowers: Story = {
  args: {
    label: 'extension',
    floatKind: 'extension',
    connection: 'live',
    trayRole: 'leader',
    followerCount: 1,
    rate: '4.20',
    spent: '6.15',
  },
};

export const LeaderSliccstartWithFollowers: Story = {
  args: {
    label: 'sliccstart',
    floatKind: 'sliccstart',
    connection: 'live',
    trayRole: 'leader',
    followerCount: 3,
    rate: '12.07',
  },
};

/** Tray leader, zero followers — dot live, no middle segment, label unchanged. */
export const LeaderNoFollowers: Story = {
  args: {
    label: 'npx',
    floatKind: 'npx',
    connection: 'live',
    trayRole: 'leader',
    rate: '1.05',
  },
};

/** Following another leader — follower pip, float kind still names this surface. */
export const FollowerConnected: Story = {
  args: {
    label: 'extension',
    floatKind: 'extension',
    connection: 'live',
    trayRole: 'follower',
  },
};

export const FollowerConnecting: Story = {
  args: {
    label: 'cherry',
    floatKind: 'cherry',
    connection: 'connecting',
    trayRole: 'follower',
  },
};

export const FollowerReconnecting: Story = {
  args: {
    label: 'npx',
    floatKind: 'npx',
    connection: 'reconnecting',
    trayRole: 'follower',
  },
};

export const FollowerError: Story = {
  args: {
    label: 'standalone',
    floatKind: 'standalone',
    connection: 'error',
    trayRole: 'follower',
  },
};

/** Leader channel open but leader busy (stalled) — amber ring, still live. */
export const LeaderStalled: Story = {
  args: {
    label: 'sliccstart',
    floatKind: 'sliccstart',
    connection: 'stalled',
    trayRole: 'follower',
    followerCount: 0,
  },
};

export const WithSpent: Story = {
  args: {
    label: 'npx',
    floatKind: 'npx',
    connection: 'offline',
    rate: '2.41',
    spent: '2.41',
  },
};

export const NarrowMobile: Story = {
  args: {
    label: 'npx',
    floatKind: 'npx',
    connection: 'live',
    trayRole: 'leader',
    followerCount: 2,
    rate: '2.41',
    spent: '12.07',
  },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

/**
 * Design review matrix — every connection health × tray role for one float kind.
 * Open this story to compare ring colors and role pips side by side.
 */
export const StatusBeaconMatrix: Story = {
  render: () => {
    const root = document.createElement('div');
    root.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:20px;';
    root.appendChild(legend());

    const roles: FloatbarTrayRole[] = ['none', 'leader', 'follower'];
    for (const role of roles) {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.style.cssText =
        'font:600 12px/1 var(--ui,system-ui);margin:0 0 10px;color:var(--ink,#111);';
      heading.textContent = `Tray role: ${trayRoleLabel(role)}`;
      section.appendChild(heading);

      const grid = document.createElement('div');
      grid.style.cssText =
        'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px 16px;';

      for (const connection of FLOATBAR_CONNECTIONS) {
        const cell = document.createElement('div');
        const bar = mountFloatbar({
          label: defaultFloatLabel('npx'),
          floatKind: 'npx',
          connection,
          trayRole: role,
          followerCount: role === 'leader' && connection === 'live' ? 2 : 0,
          rate: '3.50',
        });
        cell.append(navRow(bar));
        cell.appendChild(
          cellCaption([
            connectionLabel(connection),
            role === 'leader' && connection === 'live' ? '2 followers (segment)' : 'no followers',
          ])
        );
        grid.appendChild(cell);
      }
      section.appendChild(grid);
      root.appendChild(section);
    }
    return root;
  },
};

/**
 * Float kinds are independent of tray role — each can lead with followers.
 */
export const FloatKindOrthogonality: Story = {
  render: () => {
    const root = document.createElement('div');
    root.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:16px;';
    root.appendChild(legend());

    const grid = document.createElement('div');
    grid.style.cssText =
      'display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px 18px;';

    for (const kind of FLOATBAR_FLOAT_KINDS) {
      const cell = document.createElement('div');
      const bar = mountFloatbar({
        label: defaultFloatLabel(kind),
        floatKind: kind,
        connection: 'live',
        trayRole: 'leader',
        followerCount: 1,
        rate: '8.00',
      });
      cell.append(navRow(bar));
      cell.appendChild(cellCaption([floatKindLabel(kind), 'leading · 1 follower']));
      grid.appendChild(cell);
    }
    root.appendChild(grid);
    return root;
  },
};

/** Before/after — old label encoded tray+followers vs cleaned split. */
export const CleanupBeforeAfter: Story = {
  render: () => {
    const root = document.createElement('div');
    root.style.cssText =
      'padding:16px;display:flex;flex-direction:column;gap:20px;max-width:760px;';

    const mk = (title: string, bar: SliccFloatbar, note: string) => {
      const block = document.createElement('div');
      const h = document.createElement('h3');
      h.style.cssText = 'font:600 12px/1 var(--ui,system-ui);margin:0 0 8px;color:var(--ink,#111);';
      h.textContent = title;
      const p = document.createElement('p');
      p.style.cssText = 'font:11px/1.4 var(--ui,system-ui);color:var(--txt-2,#666);margin:0 0 8px;';
      p.textContent = note;
      block.append(h, p, navRow(bar));
      return block;
    };

    const before = mountFloatbar({
      label: 'tray · live',
      online: true,
      followerCount: 2,
      rate: '23.10',
    });
    before.removeAttribute('float-kind');
    before.removeAttribute('connection');
    before.removeAttribute('tray-role');

    const after = mountFloatbar({
      label: 'npx',
      floatKind: 'npx',
      connection: 'live',
      trayRole: 'leader',
      followerCount: 2,
      rate: '23.10',
    });

    root.append(
      mk(
        'Before (today)',
        before,
        'Green dot + label switches to "tray · live" when followers connect — duplicates the middle segment.'
      ),
      mk(
        'After (proposed)',
        after,
        'Beacon encodes health + float kind + role; label stays "npx"; followers only in 👥 segment.'
      )
    );
    return root;
  },
};
