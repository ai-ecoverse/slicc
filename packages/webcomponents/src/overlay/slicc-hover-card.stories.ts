import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../chat/slicc-agent-message.js';
import '../chat/slicc-link-preview.js';
import '../chat/slicc-question-prompt.js';
import '../chat/slicc-time-preview.js';
import { sampleImage } from '../chat/media-fixtures.js';
import type { SliccTimePreview } from '../chat/slicc-time-preview.js';
import './slicc-hover-card.js';
import { SliccHoverCard } from './slicc-hover-card.js';

const meta: Meta = {
  title: 'Overlay/HoverCard',
  component: 'slicc-hover-card',
  tags: ['autodocs'],
};

export default meta;

function canvas(): HTMLDivElement {
  const wrap = document.createElement('div');
  // Paint the canvas: the theme toolbar flips tokens, not the page.
  Object.assign(wrap.style, {
    maxWidth: '640px',
    background: 'var(--canvas)',
    color: 'var(--ink)',
    padding: '16px 16px 360px',
  });
  return wrap;
}

function linkPreview(attrs: Record<string, string>): HTMLElement {
  const el = document.createElement('slicc-link-preview');
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** Content for each `data-preview` anchor, standing in for the webapp's fetcher. */
function contentFor(anchor: HTMLElement): HTMLElement | null {
  switch (anchor.dataset.preview) {
    case 'link':
      return linkPreview({
        url: 'https://docs.example.com/guides/licks',
        heading: 'Licks — external events that wake the cone',
        description: 'Webhooks, cron schedules, workflow completions and sprinkle events.',
        image: sampleImage('docs.example.com', '#f472b6', '#7c3aed'),
        site: 'SLICC',
      });
    case 'github':
      return linkPreview({
        url: 'https://github.com/ai-ecoverse/slicc/pull/3428',
        heading: 'fix: ignore SIGPIPE in the shell bridge',
        description: 'Closes #3418. Writes to a closed pipe no longer kill the bridge.',
        image: sampleImage('ai-ecoverse/slicc #3428', '#0f172a', '#334155', 1200, 600),
        site: 'ai-ecoverse/slicc',
        badge: 'PR #3428',
      });
    case 'time': {
      const el = document.createElement('slicc-time-preview') as SliccTimePreview;
      el.data = {
        text: anchor.textContent ?? '',
        reference: '2026-05-12T10:30:00-07:00',
        timeZone: 'America/Los_Angeles',
        locale: 'en-US',
        rrules: [],
        occurrences: [{ start: '2026-05-13T09:00:00-07:00', allDay: false }],
      };
      return el;
    }
    case 'question': {
      const el = document.createElement('slicc-question-prompt');
      el.setAttribute('question', anchor.dataset.question ?? '');
      el.setAttribute('kind', anchor.dataset.questionKind ?? 'yes-no');
      el.addEventListener('question-answer', (event) => {
        el.setAttribute('answer', (event as CustomEvent<{ answer: string }>).detail.answer);
        el.setAttribute('state', 'answered');
        anchor.setAttribute('data-answered', '');
      });
      return el;
    }
    default:
      return null;
  }
}

function wireHover(root: HTMLElement): void {
  const card = (): SliccHoverCard => SliccHoverCard.shared(root.ownerDocument);
  root.addEventListener('pointerover', (event) => {
    const anchor = (event.target as Element).closest<HTMLElement>('[data-preview]');
    if (!anchor) return;
    if (card().anchor === anchor) {
      card().cancelHide();
      return;
    }
    card().showFor(anchor, contentFor(anchor));
  });
  root.addEventListener('pointerout', (event) => {
    const anchor = (event.target as Element).closest('[data-preview]');
    if (anchor && !anchor.contains(event.relatedTarget as Node | null)) card().scheduleHide();
  });
  root.addEventListener('link-preview-resize', () => card().reposition());
}

/**
 * Every preview kind, anchored in an agent message the way the webapp
 * decorates it. Hover the underlined phrases.
 */
export const InMessage: StoryObj = {
  render: () => {
    const wrap = canvas();
    const agent = document.createElement('slicc-agent-message');
    agent.setBodyHtml(
      '<p>I read the <a href="https://docs.example.com/guides/licks" data-preview="link">lick docs</a> ' +
        'and the fix landed in ' +
        '<a class="github-mention" data-preview="github" href="https://github.com/ai-ecoverse/slicc/pull/3428">#3428</a>. ' +
        'I can re-run the benchmark <span class="time-mention" data-preview="time">tomorrow at 9am</span>.</p>' +
        '<p><span class="agent-question" tabindex="0" data-preview="question" ' +
        'data-question="Should I open a pull request for this?" data-question-kind="yes-no">' +
        'Should I open a pull request for this?</span> ' +
        '<span class="agent-question" tabindex="0" data-preview="question" ' +
        'data-question="When should I schedule the deploy?" data-question-kind="datetime">' +
        'When should I schedule the deploy?</span></p>'
    );
    wrap.append(agent);
    wireHover(wrap);
    return wrap;
  },
};

/** The card opened programmatically, so its chrome can be judged without hovering. */
export const Open: StoryObj = {
  render: () => {
    const wrap = canvas();
    const anchor = document.createElement('span');
    anchor.textContent = 'anchor';
    anchor.style.textDecoration = 'underline';
    wrap.append(anchor);
    requestAnimationFrame(() => {
      SliccHoverCard.shared().showFor(
        anchor,
        linkPreview({
          url: 'https://github.com/ai-ecoverse/slicc/issues/3418',
          heading: 'Shell bridge dies on SIGPIPE',
          description: 'Piping into head kills the bridge process.',
          image: sampleImage('ai-ecoverse/slicc #3418', '#0f172a', '#334155', 1200, 600),
          site: 'ai-ecoverse/slicc',
          badge: 'Issue #3418',
        })
      );
    });
    return wrap;
  },
};
