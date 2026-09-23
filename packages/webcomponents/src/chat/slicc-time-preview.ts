import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import {
  dayBar,
  describeRecurrence,
  formatClock,
  formatDay,
  formatDayKey,
  formatDuration,
  formatRange,
  occurrenceDay,
  relativeLabel,
  type TimeOccurrence,
  type TimePreviewData,
  weekStrip,
} from './time-preview-model.js';

const STYLE = `
:host{display:block;width:300px;max-width:100%;color:var(--ink);}
:host([hidden]){display:none;}
.wrap{display:flex;flex-direction:column;gap:10px;padding:12px;}
.phrase{
  display:flex;align-items:center;gap:6px;min-width:0;
  font-size:11px;color:color-mix(in srgb,var(--ink) 60%,transparent);
}
.phrase span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.headline{display:flex;flex-direction:column;gap:2px;}
.day{font-weight:650;font-size:17px;line-height:1.2;letter-spacing:-.01em;}
.range{font-size:13px;font-variant-numeric:tabular-nums;}
.meta{font-size:11.5px;color:color-mix(in srgb,var(--ink) 62%,transparent);}
.repeat{
  align-self:flex-start;display:inline-flex;align-items:center;gap:5px;
  padding:1px 8px;border-radius:999px;
  font:600 11px/1.6 var(--ui);
  color:var(--ctx,var(--ink));
  background:color-mix(in srgb,var(--ctx,var(--ink)) 14%,transparent);
}
.week{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}
.cell{
  display:flex;flex-direction:column;align-items:center;gap:1px;
  padding:4px 0;border-radius:8px;
  font-variant-numeric:tabular-nums;
}
.cell .wd{font-size:10px;color:color-mix(in srgb,var(--ink) 55%,transparent);}
.cell .dn{font-size:12.5px;font-weight:550;}
.cell[data-today]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ink) 30%,transparent);}
.cell[data-marked]{background:var(--ctx,var(--ink));color:var(--canvas,#fff);}
.cell[data-marked] .wd{color:inherit;opacity:.8;}
.bar{position:relative;height:18px;}
.track{
  position:absolute;left:0;right:0;top:7px;height:4px;border-radius:2px;
  background:color-mix(in srgb,var(--ink) 10%,transparent);
}
.fill{
  position:absolute;top:5px;height:8px;min-width:8px;border-radius:4px;
  background:var(--ctx,var(--ink));transform:translateX(-4px);
}
.fill[data-range]{transform:none;}
.now{position:absolute;top:1px;width:2px;height:16px;border-radius:1px;background:var(--rose,#e5484d);}
.ticks{
  display:flex;justify-content:space-between;
  font-size:9.5px;color:color-mix(in srgb,var(--ink) 45%,transparent);
  font-variant-numeric:tabular-nums;
}
.upcoming{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;}
.upcoming li{
  display:flex;justify-content:space-between;gap:8px;
  font-size:11.5px;font-variant-numeric:tabular-nums;
}
.upcoming li span:last-child{color:color-mix(in srgb,var(--ink) 60%,transparent);}
.label{font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  color:color-mix(in srgb,var(--ink) 50%,transparent);}
`;
const SHEET = sheet(STYLE);

/** Upcoming occurrences listed under the headline, after the first. */
const MAX_UPCOMING = 4;

/**
 * `<slicc-time-preview>` — the hover card content for a date or time the agent
 * wrote: the absolute day and time in the viewer's zone, how far away it is,
 * a week strip with every occurrence marked, a 24-hour bar for the time of
 * day, and the next few dates of a recurring schedule.
 *
 * Purely presentational: set {@link data} to a resolved expression (webapp
 * `core/time-mentions.ts` produces them). All formatting is `Intl`, in the
 * data's `timeZone` and `locale`, so the same data renders the same way in a
 * story, a test, and the live transcript.
 */
export class SliccTimePreview extends HTMLElement {
  readonly #root: ShadowRoot;
  #data: TimePreviewData | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  get data(): TimePreviewData | null {
    return this.#data;
  }

  set data(value: TimePreviewData | null) {
    this.#data = value
      ? {
          ...value,
          occurrences: value.occurrences.map((occ) => ({ ...occ })),
          rrules: [...value.rrules],
        }
      : null;
    if (this.isConnected) this.#render();
  }

  #render(): void {
    const data = this.#data;
    if (!data) {
      this.#root.replaceChildren();
      return;
    }
    const first = data.occurrences[0];
    const wrap = h(
      'div',
      { class: 'wrap' },
      h(
        'div',
        { class: 'phrase', part: 'phrase' },
        iconEl('calendar-clock', { size: 12 }),
        h('span', null, `“${data.text}”`)
      ),
      first ? this.#headline(first, data) : h('div', { class: 'day' }, 'No date found'),
      data.rrules[0]
        ? h(
            'span',
            { class: 'repeat', part: 'repeat' },
            iconEl('repeat', { size: 11 }),
            describeRecurrence(data.rrules[0])
          )
        : null,
      this.#week(data),
      first ? this.#bar(first, data) : null,
      this.#upcoming(data)
    );
    this.#root.replaceChildren(wrap);
  }

  #headline(first: TimeOccurrence, data: TimePreviewData): HTMLElement {
    const startMs = Date.parse(first.start);
    const key = occurrenceDay(first, data.timeZone);
    const day = first.allDay && key ? formatDayKey(key, data) : formatDay(startMs, data);
    const refMs = Date.parse(data.reference);
    const meta: string[] = [];
    if (!Number.isNaN(startMs) && !Number.isNaN(refMs)) {
      meta.push(relativeLabel(startMs, refMs, data.locale));
    }
    const endMs = first.end ? Date.parse(first.end) : Number.NaN;
    if (!first.allDay && !Number.isNaN(endMs) && endMs > startMs) {
      meta.push(formatDuration(endMs - startMs));
    }
    meta.push(data.timeZone);
    return h(
      'div',
      { class: 'headline' },
      h('div', { class: 'day', part: 'day' }, day),
      h('div', { class: 'range', part: 'range' }, formatRange(first, data)),
      h('div', { class: 'meta', part: 'meta' }, meta.join(' · '))
    );
  }

  #week(data: TimePreviewData): HTMLElement {
    const cells = weekStrip(data).map((day) =>
      h(
        'div',
        {
          class: 'cell',
          'data-marked': day.marked,
          'data-today': day.today,
          title: day.key,
        },
        h('span', { class: 'wd' }, day.weekday),
        h('span', { class: 'dn' }, day.day)
      )
    );
    return h('div', { class: 'week', part: 'week' }, ...cells);
  }

  #bar(first: TimeOccurrence, data: TimePreviewData): HTMLElement | null {
    const bar = dayBar(first, data);
    if (!bar) return null;
    const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
    const isRange = bar.to > bar.from;
    const fill = h('span', {
      class: 'fill',
      'data-range': isRange,
      style: `left:${pct(bar.from)};${isRange ? `width:${pct(bar.to - bar.from)};` : ''}`,
    });
    return h(
      'div',
      { part: 'day-bar' },
      h(
        'div',
        { class: 'bar' },
        h('span', { class: 'track' }),
        fill,
        bar.now !== undefined ? h('span', { class: 'now', style: `left:${pct(bar.now)}` }) : null
      ),
      h(
        'div',
        { class: 'ticks' },
        h('span', null, '0'),
        h('span', null, '6'),
        h('span', null, '12'),
        h('span', null, '18'),
        h('span', null, '24')
      )
    );
  }

  #upcoming(data: TimePreviewData): HTMLElement | null {
    const rest = data.occurrences.slice(1, 1 + MAX_UPCOMING);
    if (rest.length === 0) return null;
    const items = rest.map((occ) => {
      const key = occurrenceDay(occ, data.timeZone);
      const ms = Date.parse(occ.start);
      const day = occ.allDay && key ? formatDayKey(key, data) : formatDay(ms, data);
      return h(
        'li',
        null,
        h('span', null, day),
        h('span', null, occ.allDay ? 'All day' : formatClock(ms, data))
      );
    });
    return h(
      'div',
      null,
      h('div', { class: 'label' }, 'Next'),
      h('ul', { class: 'upcoming', part: 'upcoming' }, ...items)
    );
  }
}

define('slicc-time-preview', SliccTimePreview);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-time-preview': SliccTimePreview;
  }
}
