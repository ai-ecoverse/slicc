import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-question-prompt.js';
import type { QuestionKind, QuestionState } from './slicc-question-prompt.js';

interface QuestionPromptArgs {
  question: string;
  kind: QuestionKind;
  state: QuestionState;
  answer?: string;
  note?: string;
}

const meta: Meta<QuestionPromptArgs> = {
  title: 'Chat/QuestionPrompt',
  component: 'slicc-question-prompt',
  tags: ['autodocs'],
  argTypes: {
    question: { control: 'text' },
    kind: {
      control: 'select',
      options: ['yes-no', 'text', 'number', 'datetime', 'date', 'email'],
    },
    state: { control: 'inline-radio', options: ['open', 'answered', 'inert'] },
    answer: { control: 'text', description: 'Shown in the answered state' },
    note: { control: 'text', description: 'Shown in the inert state' },
  },
  render: (args) => {
    const frame = document.createElement('div');
    Object.assign(frame.style, {
      display: 'inline-block',
      background: 'var(--canvas)',
      color: 'var(--ink)',
      font: '13px/1.4 var(--ui)',
      border: '1px solid color-mix(in srgb, var(--ink) 14%, transparent)',
      borderRadius: '12px',
      boxShadow: '0 10px 30px rgba(0,0,0,.16)',
    });
    const el = document.createElement('slicc-question-prompt');
    for (const [key, value] of Object.entries(args)) {
      if (value) el.setAttribute(key, String(value));
    }

    el.addEventListener('question-answer', (event) => {
      const { answer } = (event as CustomEvent<{ answer: string }>).detail;
      el.setAttribute('answer', answer);
      el.setAttribute('state', 'answered');
    });
    frame.append(el);
    return frame;
  },
};

export default meta;
type Story = StoryObj<QuestionPromptArgs>;

export const YesNo: Story = {
  args: { question: 'Should I open a pull request for this?', kind: 'yes-no', state: 'open' },
};
export const FreeText: Story = {
  args: { question: 'Which branch should I base it on?', kind: 'text', state: 'open' },
};
export const HowMany: Story = {
  args: { question: 'How many retries should the fetch get?', kind: 'number', state: 'open' },
};
export const When: Story = {
  args: { question: 'When should I schedule the deploy?', kind: 'datetime', state: 'open' },
};
export const WhichDay: Story = {
  args: { question: 'What date is the launch?', kind: 'date', state: 'open' },
};
export const Email: Story = {
  args: { question: 'Who should I send the report to?', kind: 'email', state: 'open' },
};
export const Answered: Story = {
  args: {
    question: 'Should I open a pull request for this?',
    kind: 'yes-no',
    state: 'answered',
    answer: 'yes',
  },
};
export const Inert: Story = {
  args: {
    question: 'Which branch should I base it on?',
    kind: 'text',
    state: 'inert',
    note: 'Only the latest agent message can be answered here.',
  },
};
