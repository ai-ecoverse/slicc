import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-avatar.js';

interface AvatarArgs {
  initials?: string;
  name?: string;
  src?: string;
  email?: string;
  size?: string;
  label?: string;
}

const meta: Meta<AvatarArgs> = {
  title: 'Primitives/Avatar',
  component: 'slicc-avatar',
  tags: ['autodocs'],
  argTypes: {
    initials: { control: 'text', description: 'Explicit initials (wins over name)' },
    name: { control: 'text', description: 'Full name; up to 2 uppercase initials are derived' },
    src: { control: 'text', description: 'Optional image URL for an image-backed avatar' },
    email: {
      control: 'text',
      description: 'Optional email → Gravatar (SHA-256, d=404), shown behind initials',
    },
    size: { control: 'text', description: 'Optional CSS length overriding the --ctl-h square' },
    label: { control: 'text', description: 'Optional accessible label' },
  },
  render: ({ initials, name, src, email, size, label }) => {
    const el = document.createElement('slicc-avatar');
    if (initials) el.setAttribute('initials', initials);
    if (name) el.setAttribute('name', name);
    if (src) el.setAttribute('src', src);
    if (email) el.setAttribute('email', email);
    if (size) el.setAttribute('size', size);
    if (label) el.setAttribute('label', label);
    return el;
  },
};

export default meta;
type Story = StoryObj<AvatarArgs>;

/** The prototype nav avatar: explicit "PM" initials over the rainbow gradient. */
export const Initials: Story = { args: { initials: 'PM' } };

/** Initials derived from a full name (first + last word). */
export const DerivedFromName: Story = { args: { name: 'Pat Mercury' } };

/** Single-word name yields the first two letters. */
export const SingleName: Story = { args: { name: 'sliccy' } };

/**
 * Gravatar: initials render immediately, then the avatar async-swaps to the
 * Gravatar image (SHA-256 of the trimmed/lowercased email, `d=404`) layered over
 * the rainbow gradient. `beau@dodds.net` is a known Gravatar account, so the
 * portrait resolves; the initials remain underneath as the ground/fallback.
 */
export const Gravatar: Story = { args: { email: 'beau@dodds.net', name: 'Beau Dodds' } };

/**
 * Gravatar fallback: an address with no associated Gravatar 404s (`d=404`), so
 * the avatar holds the derived initials over the rainbow ground.
 */
export const GravatarFallback: Story = {
  args: { email: 'no-such-user-12345@example.invalid', name: 'Unknown Person' },
};

/** Larger Gravatar — the `s=` request scales with the rendered (2×) size. */
export const GravatarLarge: Story = {
  args: { email: 'beau@dodds.net', name: 'Beau Dodds', size: '64px' },
};

/**
 * Image-backed avatar: an explicit `src` cover image fills the circle and wins
 * over both `email` and initials.
 */
export const ImageSrc: Story = {
  args: {
    name: 'Pat Mercury',
    src: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4',
  },
};

/** Explicit `src` takes precedence even when an `email` is also present. */
export const SrcWinsOverEmail: Story = {
  args: {
    name: 'Pat Mercury',
    email: 'beau@dodds.net',
    src: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4',
  },
};

/** The full size matrix: small / default / large via the `size` attribute. */
export const Sizes: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.gap = '16px';
    wrap.style.alignItems = 'center';
    for (const size of ['22px', '30px', '48px', '64px']) {
      const el = document.createElement('slicc-avatar');
      el.setAttribute('initials', 'PM');
      el.setAttribute('size', size);
      wrap.appendChild(el);
    }
    return wrap;
  },
};

/** Larger size via the `size` attribute (any CSS length). */
export const Large: Story = { args: { initials: 'PM', size: '48px' } };

/** Smaller size via the `size` attribute. */
export const Small: Story = { args: { initials: 'PM', size: '22px' } };
