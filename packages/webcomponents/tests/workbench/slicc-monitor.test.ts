import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';
import { type MonitorSection, SliccMonitor } from '../../src/workbench/slicc-monitor.js';

function mount(sections?: MonitorSection[]): SliccMonitor {
  const el = document.createElement('slicc-monitor') as SliccMonitor;
  if (sections) el.sections = sections;
  document.body.appendChild(el);
  return el;
}

const SAMPLE_SECTIONS: MonitorSection[] = [
  {
    id: 'scoops',
    label: 'Scoops',
    count: 2,
    rows: [
      { name: 'sliccy (cone)', meta: 'processing', active: true },
      { name: 'researcher', meta: 'idle' },
    ],
  },
  {
    id: 'cron',
    label: 'Cron Tasks',
    count: 1,
    rows: [{ name: 'daily-backup', meta: '0 3 * * *', active: true }],
  },
  { id: 'webhooks', label: 'Webhooks', count: 0, rows: [] },
];

describe('slicc-monitor', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc_monitor_collapsed');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-monitor')).toBe(SliccMonitor);
  });

  it('renders into light DOM (no shadow root)', () => {
    const el = mount(SAMPLE_SECTIONS);
    expect(el.shadowRoot).toBeNull();
  });

  it('renders a section per entry with correct data-section', () => {
    const el = mount(SAMPLE_SECTIONS);
    const sections = el.querySelectorAll('[data-section]');
    expect(sections).toHaveLength(3);
    expect(sections[0].getAttribute('data-section')).toBe('scoops');
    expect(sections[1].getAttribute('data-section')).toBe('cron');
    expect(sections[2].getAttribute('data-section')).toBe('webhooks');
  });

  it('renders rows with name and meta text', () => {
    const el = mount(SAMPLE_SECTIONS);
    const rows = el.querySelectorAll('[data-section="scoops"] .monitor-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.monitor-row__name')!.textContent).toBe('sliccy (cone)');
    expect(rows[0].querySelector('.monitor-row__meta')!.textContent).toBe('processing');
    expect(rows[1].querySelector('.monitor-row__name')!.textContent).toBe('researcher');
  });

  it('applies active dot class for active rows', () => {
    const el = mount(SAMPLE_SECTIONS);
    const dots = el.querySelectorAll('[data-section="scoops"] .monitor-row__dot');
    expect(dots[0].classList.contains('monitor-row__dot--active')).toBe(true);
    expect(dots[1].classList.contains('monitor-row__dot--active')).toBe(false);
  });

  it('applies error dot class for error rows', () => {
    const el = mount([
      {
        id: 'err',
        label: 'Errors',
        count: 1,
        rows: [{ name: 'broken', meta: 'err', error: true }],
      },
    ]);
    const dot = el.querySelector('.monitor-row__dot--error');
    expect(dot).not.toBeNull();
  });

  it('marks empty sections with --empty modifier', () => {
    const el = mount(SAMPLE_SECTIONS);
    const empty = el.querySelector('[data-section="webhooks"]');
    expect(empty!.classList.contains('monitor-section--empty')).toBe(true);
    const notEmpty = el.querySelector('[data-section="scoops"]');
    expect(notEmpty!.classList.contains('monitor-section--empty')).toBe(false);
  });

  it('shows count badges', () => {
    const el = mount(SAMPLE_SECTIONS);
    const counts = el.querySelectorAll('.monitor-section__count');
    expect(counts[0].textContent).toBe('2');
    expect(counts[1].textContent).toBe('1');
    expect(counts[2].textContent).toBe('0');
  });

  it('renders a refresh button in toolbar', () => {
    const el = mount(SAMPLE_SECTIONS);
    const btn = el.querySelector('.monitor-toolbar__refresh');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Refresh');
  });

  it('dispatches slicc-monitor-refresh on refresh click', () => {
    const el = mount(SAMPLE_SECTIONS);
    const handler = vi.fn();
    el.addEventListener('slicc-monitor-refresh', handler);
    const btn = el.querySelector<HTMLButtonElement>('.monitor-toolbar__refresh')!;
    btn.click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('collapses a section on header click and persists state', () => {
    const el = mount(SAMPLE_SECTIONS);
    const header = el.querySelector<HTMLButtonElement>(
      '[data-section="scoops"] .monitor-section__header'
    )!;
    header.click();
    // Re-query after re-render
    const body = el.querySelector('[data-section="scoops"] .monitor-section__body');
    const updatedHeader = el.querySelector<HTMLButtonElement>(
      '[data-section="scoops"] .monitor-section__header'
    )!;
    expect(body!.hasAttribute('hidden')).toBe(true);
    expect(updatedHeader.getAttribute('aria-expanded')).toBe('false');
    const stored = JSON.parse(localStorage.getItem('slicc_monitor_collapsed')!);
    expect(stored).toContain('scoops');
  });

  it('restores collapsed state from localStorage', () => {
    localStorage.setItem('slicc_monitor_collapsed', JSON.stringify(['cron']));
    const el = mount(SAMPLE_SECTIONS);
    const body = el.querySelector('[data-section="cron"] .monitor-section__body');
    expect(body!.hasAttribute('hidden')).toBe(true);
  });

  it('re-renders when sections property is updated', () => {
    const el = mount(SAMPLE_SECTIONS);
    expect(el.querySelectorAll('[data-section]')).toHaveLength(3);
    el.sections = [{ id: 'only', label: 'Only', count: 0, rows: [] }];
    expect(el.querySelectorAll('[data-section]')).toHaveLength(1);
    expect(el.querySelector('[data-section="only"]')).not.toBeNull();
  });

  it('shows section meta when provided', () => {
    const el = mount([
      {
        id: 'cost',
        label: 'Cost',
        count: 1,
        meta: '$1.23',
        rows: [{ name: 'Total', meta: '$1.23' }],
      },
    ]);
    const meta = el.querySelector('[data-section="cost"] .monitor-section__meta');
    expect(meta).not.toBeNull();
    expect(meta!.textContent).toBe('$1.23');
  });

  it('sections getter returns a copy (not a live reference)', () => {
    const el = mount(SAMPLE_SECTIONS);
    const copy = el.sections;
    copy.push({ id: 'extra', label: 'X', count: 0, rows: [] });
    expect(el.sections).toHaveLength(3);
  });
});
