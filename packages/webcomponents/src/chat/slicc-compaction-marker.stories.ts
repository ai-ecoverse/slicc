import type { Meta, StoryObj } from '@storybook/web-components-vite';

import './slicc-agent-message.js';
import './slicc-compaction-marker.js';
import './slicc-user-message.js';

interface CompactionMarkerArgs {
  trigger?: 'threshold' | 'overflow' | 'idle';
  state?: 'summarizing' | 'summarized' | 'fallback';
  transcript?: string;
  label?: string;
  theme?: 'light' | 'dark';
}

const SNAPSHOT = '/sessions/live-cone-mtlor6sy-8egf.md';

function build(args: CompactionMarkerArgs): HTMLElement {
  const el = document.createElement('slicc-compaction-marker');
  if (args.trigger) el.setAttribute('trigger', args.trigger);
  if (args.state) el.setAttribute('state', args.state);
  if (args.transcript) el.setAttribute('transcript', args.transcript);
  if (args.label != null) el.setAttribute('label', args.label);
  if (args.theme === 'dark') el.classList.add('dark');
  return el;
}

function frame(args: CompactionMarkerArgs, ...children: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('div');
  if (args.theme === 'dark') wrap.classList.add('dark');
  wrap.style.cssText =
    'width:620px;max-width:100%;padding:20px 24px;background:var(--canvas);color:var(--ink);';
  wrap.append(...children);
  return wrap;
}

function bubble(text: string, role: 'user' | 'assistant'): HTMLElement {
  const el = document.createElement(role === 'user' ? 'slicc-user-message' : 'slicc-agent-message');
  el.setAttribute('text', text);
  return el;
}

const meta: Meta<CompactionMarkerArgs> = {
  title: 'Chat/CompactionMarker',
  component: 'slicc-compaction-marker',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The thread seam marking one context-compaction round: a hairline rule broken by a ' +
          'chip naming what happened, plus a link to the pre-compaction transcript snapshot ' +
          'when one was written. Shares the day separator\u2019s geometry because it means the ' +
          'same thing to a reader \u2014 the thread is discontinuous here \u2014 but a compaction ' +
          'is an EVENT with a state, so it carries a chip rather than a bare caption. ' +
          'Replaces the plain assistant bubble compaction notices used to render as: a ' +
          'compaction is not something the model said, and the fake assistant turn it took to ' +
          'fabricate one stranded the composer in its busy state for the rest of the session. ' +
          'The wire carries `trigger` + `state`, never prose \u2014 this component and the iOS ' +
          'follower\u2019s `CompactionMarkerRow` each own their copy table.',
      },
    },
  },
  argTypes: {
    trigger: {
      control: 'inline-radio',
      options: ['threshold', 'overflow', 'idle'],
      description: 'What started the round; words the copy',
    },
    state: {
      control: 'inline-radio',
      options: ['summarizing', 'summarized', 'fallback'],
      description:
        'How it ended. `discarded` has no story: a round that kept nothing has no row, so the ' +
        'host removes the element.',
    },
    transcript: { control: 'text', description: '`/sessions` path of the snapshot' },
    label: { control: 'text', description: 'Copy override (bypasses the derived table)' },
    theme: { control: 'inline-radio', options: ['light', 'dark'], description: 'Theme override' },
  },
  render: (args) => frame(args, build(args)),
};

export default meta;
type Story = StoryObj<CompactionMarkerArgs>;

export const Default: Story = {
  args: { trigger: 'threshold', state: 'summarized', transcript: SNAPSHOT },
};

export const IdleSummarized: Story = {
  args: { trigger: 'idle', state: 'summarized', transcript: SNAPSHOT },
};

export const IdleSummarizing: Story = {
  args: { trigger: 'idle', state: 'summarizing', transcript: SNAPSHOT },
};

export const ThresholdSummarizing: Story = {
  args: { trigger: 'threshold', state: 'summarizing', transcript: SNAPSHOT },
};

export const OverflowSummarized: Story = {
  args: { trigger: 'overflow', state: 'summarized', transcript: SNAPSHOT },
};

export const Fallback: Story = {
  args: { trigger: 'threshold', state: 'fallback', transcript: SNAPSHOT },
};

export const WithoutTranscript: Story = {
  args: { trigger: 'idle', state: 'summarized' },
};

export const LongTranscriptPath: Story = {
  args: {
    trigger: 'idle',
    state: 'summarized',
    transcript: '/sessions/live-cone-a-very-long-cone-folder-name-with-suffix-8egf29ba7c.md',
  },
};

export const CustomLabel: Story = {
  args: {
    trigger: 'idle',
    state: 'summarized',
    label: 'Compacted twice while idle',
    transcript: SNAPSHOT,
  },
};

export const Dark: Story = {
  args: { trigger: 'idle', state: 'summarized', transcript: SNAPSHOT, theme: 'dark' },
};

export const FallbackDark: Story = {
  args: { trigger: 'threshold', state: 'fallback', transcript: SNAPSHOT, theme: 'dark' },
};

export const Narrow: Story = {
  args: { trigger: 'overflow', state: 'summarizing', transcript: SNAPSHOT },
  render: (args) => {
    const wrap = frame(args, build(args));
    wrap.style.width = '300px';
    return wrap;
  },
};

export const StateMatrix: Story = {
  args: { theme: 'light' },
  render: (args) => {
    const rows: HTMLElement[] = [];
    for (const state of ['summarizing', 'summarized', 'fallback'] as const) {
      for (const trigger of ['threshold', 'overflow', 'idle'] as const) {
        rows.push(build({ ...args, state, trigger, transcript: SNAPSHOT }));
      }
    }
    return frame(args, ...rows);
  },
};

export const StateMatrixDark: Story = {
  ...StateMatrix,
  args: { theme: 'dark' },
};

export const InThread: Story = {
  args: { trigger: 'idle', state: 'summarized', transcript: SNAPSHOT },
  render: (args) =>
    frame(
      args,
      bubble('Render the cut and give me a link.', 'user'),
      bubble('Rendered entirely in this browser. Direct link below.', 'assistant'),
      build(args),
      bubble('Now fix the caption at nine seconds.', 'user'),
      bubble('Found it — the payoff word was clipped. Re-rendering.', 'assistant')
    ),
};

export const InThreadDark: Story = {
  ...InThread,
  args: { trigger: 'idle', state: 'summarized', transcript: SNAPSHOT, theme: 'dark' },
};

export const TranscriptEvent: Story = {
  args: { trigger: 'idle', state: 'summarized', transcript: SNAPSHOT },
  render: (args) => {
    const marker = build(args);
    const out = document.createElement('div');
    out.style.cssText =
      'font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--txt-2);padding:6px 8px;border:1px dashed var(--line);border-radius:6px;margin-top:10px;';
    out.textContent = 'waiting for a transcript click…';
    let count = 0;
    marker.addEventListener('slicc-compaction-transcript', (e) => {
      count += 1;
      out.textContent = `slicc-compaction-transcript × ${count} → ${JSON.stringify(
        (e as CustomEvent).detail
      )}`;
    });
    return frame(args, marker, out);
  },
};
