import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { SliccTerminal } from './slicc-terminal.js';
import './slicc-terminal.js';

interface TerminalArgs {
  label?: string;
  hideHeader?: boolean;
}

// ANSI helpers so the canned sessions read like a real shell. xterm renders
// these; the story writes them with the public `write` API after connect.
const RESET = '\x1b[0m';
const DIM = (s: string) => `\x1b[90m${s}${RESET}`;
const ROSE = (s: string) => `\x1b[38;2;244;63;94m${s}${RESET}`; // --rose prompt
const GREEN = (s: string) => `\x1b[38;2;91;209;123m${s}${RESET}`; // prototype .term .ok
const VIOLET = (s: string) => `\x1b[38;2;139;92;246m${s}${RESET}`;
const CYAN = (s: string) => `\x1b[38;2;6;182;212m${s}${RESET}`;
const BOLD = (s: string) => `\x1b[1m${s}\x1b[22m`;
const PASS = ` ${GREEN(BOLD(' PASS '))} `;

const PROMPT = `${ROSE('researcher')} ${DIM('/scoops/researcher')} ${ROSE('❯')} `;

/** A believable `npm test` run with green PASS lines for the default story. */
function npmTestSession(term: SliccTerminal): void {
  term.writeln(`${PROMPT}npm test`);
  term.writeln('');
  term.writeln(`${DIM('> @slicc/webcomponents@0.0.0 test')}`);
  term.writeln(`${DIM('> vitest run')}`);
  term.writeln('');
  term.writeln(`${DIM('RUN')} ${BOLD('v3.2.0')} ${DIM('packages/webcomponents')}`);
  term.writeln('');
  term.writeln(`${PASS}tests/workbench/slicc-terminal.test.ts ${DIM('(8 tests) 142ms')}`);
  term.writeln(`${PASS}tests/workbench/slicc-surface.test.ts ${DIM('(22 tests) 088ms')}`);
  term.writeln(`${PASS}tests/workbench/slicc-tab-bar.test.ts ${DIM('(31 tests) 121ms')}`);
  term.writeln(`${PASS}tests/pill/slicc-pill.test.ts ${DIM('(19 tests) 097ms')}`);
  term.writeln('');
  term.writeln(` ${DIM('Test Files')}  ${GREEN('4 passed')} ${DIM('(4)')}`);
  term.writeln(`      ${DIM('Tests')}  ${GREEN('80 passed')} ${DIM('(80)')}`);
  term.writeln(`   ${DIM('Start at')}  14:21:07`);
  term.writeln(`   ${DIM('Duration')}  ${VIOLET('1.04s')}`);
  term.writeln('');
  term.writeln(`${GREEN('✓')} all green — ${CYAN('coverage')} above floor`);
  term.write(PROMPT);
}

/** A short grep/inspect session — the prototype's terminal surface content. */
function grepSession(term: SliccTerminal): void {
  term.writeln(`${PROMPT}grep -rn "hero" src/ | wc -l`);
  term.writeln(`${DIM('17 matches · 4 files')}`);
  term.writeln(`${PROMPT}cat src/hero.tsx`);
  term.writeln(`${DIM('… dark canvas · mono headline · 6-button row …')}`);
  term.write(PROMPT);
}

/**
 * Re-run the writer whenever the element (re)connects — Storybook may mount the
 * same node across HMR / docs renders, and the terminal clears its buffer on
 * disconnect. `requestAnimationFrame` lets xterm `open()` settle first.
 */
function withSession(el: SliccTerminal, paint: (t: SliccTerminal) => void): SliccTerminal {
  requestAnimationFrame(() => requestAnimationFrame(() => paint(el)));
  return el;
}

function makeTerminal(args: TerminalArgs): SliccTerminal {
  const el = document.createElement('slicc-terminal') as SliccTerminal;
  if (args.label) el.setAttribute('label', args.label);
  if (args.hideHeader) el.setAttribute('hide-header', '');
  el.style.width = '720px';
  el.style.height = '360px';
  return el;
}

const meta: Meta<TerminalArgs> = {
  title: 'Workbench/Terminal',
  component: 'slicc-terminal',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Header title text' },
    hideHeader: { control: 'boolean', description: 'Hide the title bar' },
  },
  parameters: {
    docs: {
      description: {
        component:
          'xterm.js-backed dark terminal surface. The xterm stylesheet is injected ' +
          'into the shadow root so rows render inside shadow DOM; FitAddon keeps the ' +
          'buffer sized to the host. Sessions below are pre-populated via the public ' +
          '`write`/`writeln` API.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<TerminalArgs>;

/** Default — a green `npm test` run, the canonical reviewable state. */
export const NpmTestRun: Story = {
  render: () => withSession(makeTerminal({ label: 'Terminal' }), npmTestSession),
};

/** A short grep / cat session lifted from the prototype terminal surface. */
export const GrepSession: Story = {
  render: () => withSession(makeTerminal({ label: 'researcher' }), grepSession),
};

/** Header hidden — the terminal fills the whole dark frame. */
export const NoHeader: Story = {
  render: () => withSession(makeTerminal({ hideHeader: true }), npmTestSession),
};

/** Empty terminal with just a prompt — the at-rest state. */
export const EmptyPrompt: Story = {
  render: () =>
    withSession(makeTerminal({ label: 'Terminal' }), (t) => {
      t.writeln(`${DIM('slicc')} ${DIM('shell — type a command')}`);
      t.write(PROMPT);
    }),
};
