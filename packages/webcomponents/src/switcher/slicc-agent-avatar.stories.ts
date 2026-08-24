import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { h, sheet } from '../internal/dom.js';
import type { AgentActivity } from './avatar-expression.js';
import type { SliccAgentAvatar } from './slicc-agent-avatar.js';
import './slicc-agent-avatar.js';

interface AvatarArgs {
  type?: 'cone' | 'scoop';
  color?: string;
  activity?: AgentActivity;
  fill?: number;
  eyes?: 'open' | 'none' | 'dead';
  connection?: 'connected' | 'disconnected';
  blink?: boolean;
  drowseDelay?: number;
  gazeTarget?: string;
  /** Re-fire a transient (glower/scrutiny) so it stays engaged for a screenshot. */
  sustain?: 'glower' | 'scrutinize';
  /** Render a stand-in composer the `awaiting` gaze can anchor to. */
  composer?: boolean;
  caption?: string;
}

const HUE = '#06b6d4';
/** Bounded repeat count: long enough for a capture, short enough not to leak. */
const SUSTAIN_REPEATS = 40;

function avatarEl(args: AvatarArgs, size: number): SliccAgentAvatar {
  const avatar = document.createElement('slicc-agent-avatar') as SliccAgentAvatar;
  avatar.setAttribute('type', args.type ?? 'scoop');
  avatar.setAttribute('color', args.color ?? HUE);
  avatar.setAttribute('fill', String(args.fill ?? 38));
  avatar.setAttribute('eyes', args.eyes ?? 'open');
  if (args.activity) avatar.setAttribute('activity', args.activity);
  if (args.connection) avatar.setAttribute('connection', args.connection);
  if (args.blink !== false) avatar.toggleAttribute('blink', true);
  if (args.drowseDelay !== undefined) avatar.setAttribute('drowse-delay', String(args.drowseDelay));
  if (args.gazeTarget) avatar.setAttribute('gaze-target', args.gazeTarget);
  avatar.style.width = `${size}px`;
  avatar.style.height = `${size}px`;
  avatar.style.setProperty('--slicc-agent-tabs-hue', args.color ?? HUE);
  return avatar;
}

function sustain(avatar: SliccAgentAvatar, method: 'glower' | 'scrutinize', every: number): void {
  let left = SUSTAIN_REPEATS;
  const fire = (): void => {
    avatar[method]();
    left -= 1;
    if (left <= 0) window.clearInterval(timer);
  };
  const timer = window.setInterval(fire, every);
  requestAnimationFrame(fire);
}

/** One card: the face at review size, the same face at 26 px, and a caption. */
function card(args: AvatarArgs): HTMLElement {
  const big = avatarEl(args, 148);
  const small = avatarEl(args, 26);
  if (args.sustain) {
    sustain(big, args.sustain, args.sustain === 'scrutinize' ? 300 : 2000);
    sustain(small, args.sustain, args.sustain === 'scrutinize' ? 300 : 2000);
  }
  const atSize = h(
    'div',
    { style: 'display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px;' },
    small,
    '26 px'
  );
  return h(
    'div',
    {
      style:
        'display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px;border:1px solid var(--line);border-radius:16px;background:var(--canvas);min-width:200px;',
    },
    big,
    atSize,
    h(
      'div',
      { style: 'font:600 12px/1.4 system-ui;letter-spacing:.04em;text-align:center;' },
      args.caption ?? args.activity ?? 'no activity'
    )
  );
}

function composerStub(): HTMLElement {
  return h(
    'div',
    {
      id: 'story-composer',
      style:
        'margin-top:28px;width:min(560px,90vw);padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:var(--canvas);color:var(--muted);font:14px/1.4 system-ui;',
    },
    'Your move — the eyes watch this box'
  );
}

function frame(cards: AvatarArgs[], composer = false): HTMLElement {
  const row = h(
    'div',
    { style: 'display:flex;flex-wrap:wrap;gap:18px;justify-content:center;' },
    ...cards.map(card)
  );
  return h(
    'div',
    { style: 'display:flex;flex-direction:column;align-items:center;padding:12px;' },
    row,
    composer ? composerStub() : null
  );
}

function render(args: AvatarArgs): HTMLElement {
  return frame([args], args.composer);
}

const meta: Meta<AvatarArgs> = {
  title: 'Switcher/AgentAvatar',
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  render,
};

export default meta;
type Story = StoryObj<AvatarArgs>;

export const Default: Story = {
  args: { caption: 'no activity attribute — pointer tracking' },
  parameters: {
    docs: {
      description: {
        story:
          'Backward compatibility: with no `activity` attribute the avatar keeps ' +
          'the four original channels and tracks the pointer, exactly as it ships today.',
      },
    },
  },
};

export const ActivityMatrix: Story = {
  render: () =>
    frame(
      (['idle', 'thinking', 'working', 'awaiting'] as const).map((activity) => ({
        activity,
        fill: 38,
        caption: activity,
      })),
      true
    ),
  parameters: {
    docs: {
      description: {
        story:
          'The shape channel: thinking, idle and awaiting are circles; a tool call ' +
          'squares the sockets and pupils up. Thinking also wears the quizzical brows ' +
          'and saccades up-and-away; awaiting makes eye contact with the composer.',
      },
    },
  },
};

export const Idle: Story = {
  args: { activity: 'idle', caption: 'lazy wander' },
  parameters: {
    docs: {
      description: {
        story: 'Idle looks around on its own every ~4 s and ignores the pointer entirely.',
      },
    },
  },
};

export const Thinking: Story = {
  args: { activity: 'thinking', caption: 'quizzical brows + saccades' },
  parameters: {
    docs: {
      description: {
        story:
          'Brows slide in asymmetric — one cocked, one settled — and RE-COCK at each ' +
          'blink apex, so thinking gets a beat: hmm… (blink) …hmm?',
      },
    },
  },
};

export const Working: Story = {
  args: { activity: 'working', caption: 'tool running' },
};

export const WorkingHighFill: Story = {
  args: { activity: 'working', fill: 95, caption: 'working · 95% fill' },
  parameters: {
    docs: {
      description: {
        story:
          'At high fill a squared pupil becomes a slab; the socket stays the reference ' +
          'shape so the eye still reads as an eye.',
      },
    },
  },
};

export const Awaiting: Story = {
  args: {
    activity: 'awaiting',
    gazeTarget: '#story-composer',
    composer: true,
    caption: 'eye contact',
  },
};

export const Drowse: Story = {
  args: {
    activity: 'awaiting',
    gazeTarget: '#story-composer',
    drowseDelay: 0,
    composer: true,
    caption: 'drowse (delay 0 s)',
  },
  parameters: {
    docs: {
      description: {
        story:
          'The chord-cut drowse, time-compressed for the story: a straight top lid ' +
          'descends from 10% to 55% over 12 s. In product the descent starts after 90 s ' +
          'and one keystroke wakes it.',
      },
    },
  },
};

export const Glower: Story = {
  args: { activity: 'thinking', sustain: 'glower', caption: 'tool call failed' },
  parameters: {
    docs: {
      description: {
        story: 'A 2.6 s top lid at 38% after a failed tool call. Reads angry; that is intended.',
      },
    },
  },
};

export const Scrutiny: Story = {
  args: { activity: 'awaiting', sustain: 'scrutinize', caption: 'you are typing' },
  parameters: {
    docs: {
      description: {
        story:
          'A raised BOTTOM lid at 22% for one second per keystroke — the agent visibly ' +
          'attends to what you are saying. Composes with the working square.',
      },
    },
  },
};

export const ScrutinyWhileWorking: Story = {
  args: { activity: 'working', sustain: 'scrutinize', caption: 'typing during a tool call' },
};

export const StaticFreeze: Story = {
  render: () =>
    frame([
      { activity: 'working', connection: 'disconnected', caption: 'static · frozen square' },
      { activity: 'thinking', connection: 'disconnected', caption: 'static · frozen circle' },
    ]),
  parameters: {
    docs: {
      description: {
        story:
          'Connection trouble outranks every expression channel: the shape freezes at its ' +
          'last committed radius and nothing morphs, saccades or blinks — motion here would ' +
          'read as liveness the agent does not have.',
      },
    },
  },
};

export const Broken: Story = {
  args: { activity: 'idle', eyes: 'dead', caption: 'eyes="dead" — unchanged' },
};

// ── The brow crop ──────────────────────────────────────────────────────────

/**
 * Re-clips the tile the way it painted before the brows were lifted out: one
 * `overflow:hidden` on `.avatar`, which is enough to shave the brows off at the
 * top and outer sides. Kept as the reference half of the BrowCrop story.
 */
const RECLIP_SHEET = sheet(`.avatar{overflow:hidden;border-radius:7px;}`);

/** One card per crop treatment, at review size and at the shipping 26 px. */
function cropCard(activity: AgentActivity, cropped: boolean): HTMLElement {
  const big = avatarEl({ activity }, 148);
  const small = avatarEl({ activity }, 26);
  if (cropped) {
    for (const avatar of [big, small]) {
      requestAnimationFrame(() => {
        const root = avatar.shadowRoot;
        if (root) root.adoptedStyleSheets = [...root.adoptedStyleSheets, RECLIP_SHEET];
      });
    }
  }
  return h(
    'div',
    {
      style:
        'display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px;' +
        'border:1px solid var(--line);border-radius:16px;background:var(--canvas);min-width:200px;',
    },
    big,
    h(
      'div',
      { style: 'display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px;' },
      small,
      '26 px'
    ),
    h(
      'div',
      { style: 'font:600 12px/1.4 system-ui;letter-spacing:.04em;text-align:center;' },
      `${activity} · ${cropped ? 'clipped at the tile (before)' : 'brows escape the crop'}`
    )
  );
}

function cropRow(activity: AgentActivity): HTMLElement {
  return h(
    'div',
    { style: 'display:flex;flex-wrap:wrap;gap:18px;justify-content:center;' },
    cropCard(activity, true),
    cropCard(activity, false)
  );
}

export const BrowCrop: Story = {
  render: () =>
    h(
      'div',
      { style: 'display:flex;flex-direction:column;align-items:center;gap:18px;padding:12px;' },
      cropRow('thinking'),
      cropRow('working')
    ),
  parameters: {
    docs: {
      description: {
        story:
          'The brows break out of the tile. `.crop` owns the roundrect and the brows ride a ' +
          'second copy of the same zoom/pan above it, so the sockets stay clipped while the ' +
          'brows read as full, cocked strokes overhanging the top edge. The left card re-clips ' +
          'at `.avatar` to show what that used to look like: at BROW_Y = 2 with a raise of up ' +
          'to -9 in a band zoomed ~2.65x, the roundrect shaved off the top and outer half of ' +
          'each brow. `working` is the control — no brows, so both halves match.',
      },
    },
  },
};
