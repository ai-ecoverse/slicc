import { beforeEach, describe, expect, it } from 'vitest';
import { SliccTimePreview } from '../../src/chat/slicc-time-preview.js';
import type { TimePreviewData } from '../../src/chat/time-preview-model.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const BASE: TimePreviewData = {
  text: 'tomorrow at 9am',
  reference: '2026-05-12T10:30:00-07:00',
  timeZone: 'America/Los_Angeles',
  locale: 'en-US',
  rrules: [],
  occurrences: [{ start: '2026-05-13T09:00:00-07:00', allDay: false }],
};

function mount(data: TimePreviewData | null): SliccTimePreview {
  const el = document.createElement('slicc-time-preview');
  el.data = data;
  document.body.append(el);
  return el;
}

const part = (el: SliccTimePreview, name: string) =>
  el.shadowRoot?.querySelector(`[part="${name}"]`) ?? null;

describe('slicc-time-preview', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-time-preview')).toBe(SliccTimePreview);
  });

  it('renders nothing without data', () => {
    const el = mount(null);
    expect(el.shadowRoot?.childElementCount).toBe(0);
  });

  it('renders the phrase, day, time, relative label and zone', () => {
    const el = mount(BASE);
    expect(part(el, 'phrase')?.textContent).toContain('tomorrow at 9am');
    expect(part(el, 'day')?.textContent).toBe('Wed, May 13');
    expect(part(el, 'range')?.textContent).toBe('9:00 AM');
    expect(part(el, 'meta')?.textContent).toBe('in 23 hours · America/Los_Angeles');
    expect(el.shadowRoot?.querySelectorAll('.week .cell').length).toBe(7);
    expect(el.shadowRoot?.querySelectorAll('.cell[data-marked]').length).toBe(1);
    expect(part(el, 'day-bar')).not.toBeNull();
    expect(part(el, 'repeat')).toBeNull();
    expect(part(el, 'upcoming')).toBeNull();
  });

  it('adds duration for a range', () => {
    const el = mount({
      ...BASE,
      occurrences: [
        { start: '2026-05-15T14:00:00-07:00', end: '2026-05-15T16:30:00-07:00', allDay: false },
      ],
    });
    expect(part(el, 'meta')?.textContent).toContain('2 h 30 min');
    expect(el.shadowRoot?.querySelector('.fill[data-range]')).not.toBeNull();
  });

  it('renders an all-day occurrence without a day bar', () => {
    const el = mount({ ...BASE, occurrences: [{ start: '2026-05-18', allDay: true }] });
    expect(part(el, 'day')?.textContent).toBe('Mon, May 18');
    expect(part(el, 'range')?.textContent).toBe('All day');
    expect(part(el, 'day-bar')).toBeNull();
  });

  it('describes a recurrence and lists the next occurrences', () => {
    const el = mount({
      ...BASE,
      rrules: ['DTSTART;TZID=America/Los_Angeles:20260513T083000\nRRULE:FREQ=DAILY'],
      occurrences: [
        { start: '2026-05-13T08:30:00-07:00', allDay: false },
        { start: '2026-05-14T08:30:00-07:00', allDay: false },
        { start: '2026-05-15T08:30:00-07:00', allDay: false },
      ],
    });
    expect(part(el, 'repeat')?.textContent).toBe('Daily');
    expect(part(el, 'upcoming')?.querySelectorAll('li').length).toBe(2);
  });

  it('says so when there is no occurrence', () => {
    const el = mount({ ...BASE, occurrences: [] });
    expect(el.shadowRoot?.textContent).toContain('No date found');
  });

  it('copies the data it is given', () => {
    const source = structuredClone(BASE);
    const el = mount(source);
    source.occurrences[0]!.start = 'mutated';
    expect(el.data?.occurrences[0]?.start).toBe(BASE.occurrences[0]?.start);
  });

  it('re-renders when data changes', () => {
    const el = mount(BASE);
    el.data = { ...BASE, text: 'next Friday' };
    expect(part(el, 'phrase')?.textContent).toContain('next Friday');
  });
});
