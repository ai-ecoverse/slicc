import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-time-preview.js';
import type { SliccTimePreview } from './slicc-time-preview.js';
import type { TimePreviewData } from './time-preview-model.js';

const REFERENCE = '2026-05-12T10:30:00-07:00';
const ZONE = 'America/Los_Angeles';

function data(partial: Pick<TimePreviewData, 'text' | 'occurrences'> & Partial<TimePreviewData>) {
  return { reference: REFERENCE, timeZone: ZONE, rrules: [], locale: 'en-US', ...partial };
}

const meta: Meta<{ data: TimePreviewData }> = {
  title: 'Chat/TimePreview',
  component: 'slicc-time-preview',
  tags: ['autodocs'],
  render: ({ data: value }) => {
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
    const el = document.createElement('slicc-time-preview') as SliccTimePreview;
    el.data = value;
    frame.append(el);
    return frame;
  },
};

export default meta;
type Story = StoryObj<{ data: TimePreviewData }>;

export const Instant: Story = {
  args: {
    data: data({
      text: 'tomorrow at 9am',
      occurrences: [{ start: '2026-05-13T09:00:00-07:00', allDay: false }],
    }),
  },
};

export const LaterToday: Story = {
  args: {
    data: data({
      text: 'in 20 minutes',
      occurrences: [{ start: '2026-05-12T10:50:00-07:00', allDay: false }],
    }),
  },
};

export const Range: Story = {
  args: {
    data: data({
      text: 'Friday from 2 to 4:30pm',
      occurrences: [
        { start: '2026-05-15T14:00:00-07:00', end: '2026-05-15T16:30:00-07:00', allDay: false },
      ],
    }),
  },
};

export const AllDay: Story = {
  args: {
    data: data({
      text: 'next Monday',
      occurrences: [{ start: '2026-05-18T00:00:00-07:00', allDay: true }],
    }),
  },
};

export const Recurring: Story = {
  args: {
    data: data({
      text: 'every weekday at 8:30am',
      rrules: [
        'DTSTART;TZID=America/Los_Angeles:20260513T083000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR',
      ],
      occurrences: [
        { start: '2026-05-13T08:30:00-07:00', allDay: false },
        { start: '2026-05-14T08:30:00-07:00', allDay: false },
        { start: '2026-05-15T08:30:00-07:00', allDay: false },
        { start: '2026-05-18T08:30:00-07:00', allDay: false },
        { start: '2026-05-19T08:30:00-07:00', allDay: false },
      ],
    }),
  },
};

export const Past: Story = {
  args: {
    data: data({
      text: 'last Thursday at noon',
      occurrences: [{ start: '2026-05-07T12:00:00-07:00', allDay: false }],
    }),
  },
};
