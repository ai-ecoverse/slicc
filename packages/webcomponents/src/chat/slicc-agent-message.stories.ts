import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { CheckItem, SliccAgentMessage } from './slicc-agent-message.js';
import './slicc-agent-message.js';

interface MessageArgs {
  thinking?: boolean;
  streaming?: boolean;
}

/** Construct an agent message, applying the boolean state attributes. */
function buildMessage({ thinking, streaming }: MessageArgs): SliccAgentMessage {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
  if (thinking) el.setAttribute('thinking', '');
  if (streaming) el.setAttribute('streaming', '');
  el.style.maxWidth = '520px';
  return el;
}

const meta: Meta<MessageArgs> = {
  title: 'Chat/AgentMessage',
  component: 'slicc-agent-message',
  tags: ['autodocs'],
  argTypes: {
    thinking: { control: 'boolean', description: 'Show the bouncing-dot thinking row' },
    streaming: { control: 'boolean', description: 'Append the typewriter caret' },
  },
  render: (args) => buildMessage(args),
};

export default meta;
type Story = StoryObj<MessageArgs>;

/** Plain prose body — rendered-markdown HTML slotted into the `.body`. */
export const Prose: Story = {
  render: () => {
    const el = buildMessage({});
    el.innerHTML =
      '<p>Sure — I dug through the <code>warm-hero</code> branch and the redesign is mostly there. ' +
      'A few <strong>follow-ups</strong> remain before it ships, but nothing structural.</p>';
    return el;
  },
};

/** A colored-dot `.plan` list — the first three bullets cycle rose / violet / cyan. */
export const Plan: Story = {
  render: () => {
    const el = buildMessage({});
    el.setPlan([
      'Warm the hero palette and swap the cold blue gradient',
      'Tighten the headline spacing on small viewports',
      'Re-run the visual regression suite',
      'Open a PR against main',
    ]);
    return el;
  },
};

/** A rounded check-badge `.check` list — default green badges. */
export const Check: Story = {
  render: () => {
    const el = buildMessage({});
    const items: CheckItem[] = [
      { text: 'Palette warmed and gradient replaced' },
      { text: 'Headline spacing fixed on mobile' },
      { text: 'Visual regression suite passing' },
    ];
    el.setCheck(items);
    return el;
  },
};

/** Check list exercising every badge accent: default, rose, cyan, violet, amber. */
export const CheckVariants: Story = {
  render: () => {
    const el = buildMessage({});
    const items: CheckItem[] = [
      { text: 'Default green check', variant: '' },
      { text: 'Rose badge', variant: 'r' },
      { text: 'Cyan badge', variant: 'cy' },
      { text: 'Violet badge', variant: 'vi' },
      { text: 'Amber badge', variant: 'am' },
    ];
    el.setCheck(items);
    return el;
  },
};

/** Thinking state — the three bouncing rose/cyan/violet dots, body hidden. */
export const Thinking: Story = {
  render: () => {
    const el = buildMessage({ thinking: true });
    el.setBodyHtml('<p>The typed plan will land here once the cone finishes thinking.</p>');
    return el;
  },
};

/** Streaming — prose with the blinking typewriter caret trailing the body. */
export const Streaming: Story = {
  render: () => {
    const el = buildMessage({ streaming: true });
    el.setBodyHtml('<p>Warming the hero palette and replacing the cold blue gradient');
    return el;
  },
};
