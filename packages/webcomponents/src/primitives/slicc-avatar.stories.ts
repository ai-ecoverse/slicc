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

export const Initials: Story = { args: { initials: 'PM' } };

export const DerivedFromName: Story = { args: { name: 'Pat Mercury' } };

export const SingleName: Story = { args: { name: 'sliccy' } };

export const Gravatar: Story = { args: { email: 'beau@dodds.net', name: 'Beau Dodds' } };

export const GravatarFallback: Story = {
  args: { email: 'no-such-user-12345@example.invalid', name: 'Unknown Person' },
};

export const GravatarLarge: Story = {
  args: { email: 'beau@dodds.net', name: 'Beau Dodds', size: '64px' },
};

export const ImageSrc: Story = {
  args: {
    name: 'Pat Mercury',
    src: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4',
  },
};

export const SrcWinsOverEmail: Story = {
  args: {
    name: 'Pat Mercury',
    email: 'beau@dodds.net',
    src: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4',
  },
};

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

export const Large: Story = { args: { initials: 'PM', size: '48px' } };

export const Small: Story = { args: { initials: 'PM', size: '22px' } };
