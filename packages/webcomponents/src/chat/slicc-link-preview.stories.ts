import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { sampleImage } from './media-fixtures.js';
import './slicc-link-preview.js';
import type { LinkPreviewState } from './slicc-link-preview.js';

interface LinkPreviewArgs {
  url: string;
  state: LinkPreviewState;
  heading?: string;
  description?: string;
  image?: string;
  site?: string;
  badge?: string;
}

const meta: Meta<LinkPreviewArgs> = {
  title: 'Chat/LinkPreview',
  component: 'slicc-link-preview',
  tags: ['autodocs'],
  argTypes: {
    url: { control: 'text' },
    state: { control: 'inline-radio', options: ['loading', 'ready', 'error'] },
    heading: { control: 'text', description: 'og:title' },
    description: { control: 'text', description: 'og:description' },
    image: { control: 'text', description: 'og:image' },
    site: { control: 'text', description: 'og:site_name (falls back to the host)' },
    badge: { control: 'text', description: 'Short label on the site row' },
  },
  render: (args) => {
    // Hover-card chrome, so the preview is judged in the frame it ships in.
    const frame = document.createElement('div');
    Object.assign(frame.style, {
      display: 'inline-block',
      background: 'var(--canvas)',
      color: 'var(--ink)',
      font: '13px/1.4 var(--ui)',
      border: '1px solid color-mix(in srgb, var(--ink) 14%, transparent)',
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 10px 30px rgba(0,0,0,.16)',
    });
    const el = document.createElement('slicc-link-preview');
    for (const [key, value] of Object.entries(args)) {
      if (value) el.setAttribute(key, String(value));
    }
    frame.append(el);
    return frame;
  },
};

export default meta;
type Story = StoryObj<LinkPreviewArgs>;

export const Ready: Story = {
  args: {
    url: 'https://docs.example.com/guides/licks',
    state: 'ready',
    heading: 'Licks — external events that wake the cone',
    description:
      'Webhooks, cron schedules, workflow completions and sprinkle events all arrive as licks. ' +
      'This guide shows how to route them to a scoop.',
    image: sampleImage('docs.example.com', '#f472b6', '#7c3aed'),
    site: 'SLICC',
  },
};

export const GitHubPullRequest: Story = {
  args: {
    url: 'https://github.com/ai-ecoverse/slicc/pull/3428',
    state: 'ready',
    heading: 'fix: ignore SIGPIPE in the shell bridge',
    description: 'Closes #3418. Writes to a closed pipe no longer kill the bridge process.',
    image: sampleImage('ai-ecoverse/slicc #3428', '#0f172a', '#334155', 1200, 600),
    site: 'ai-ecoverse/slicc',
    badge: 'PR #3428',
  },
};

export const NoImage: Story = {
  args: {
    url: 'https://example.com/changelog',
    state: 'ready',
    heading: 'Changelog',
    description: 'Every release, newest first.',
  },
};

export const Loading: Story = {
  args: { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Popover_API', state: 'loading' },
};

export const Unavailable: Story = {
  args: { url: 'https://intranet.example.internal/wiki/onboarding', state: 'error' },
};
