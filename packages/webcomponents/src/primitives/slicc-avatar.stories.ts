import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-avatar.js';

interface AvatarArgs {
  initials?: string;
  name?: string;
  src?: string;
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
    size: { control: 'text', description: 'Optional CSS length overriding the --ctl-h square' },
    label: { control: 'text', description: 'Optional accessible label' },
  },
  render: ({ initials, name, src, size, label }) => {
    const el = document.createElement('slicc-avatar');
    if (initials) el.setAttribute('initials', initials);
    if (name) el.setAttribute('name', name);
    if (src) el.setAttribute('src', src);
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

/** Image-backed avatar: a cover image fills the circle instead of initials. */
export const ImageBacked: Story = {
  args: {
    name: 'Pat Mercury',
    src: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4',
  },
};

/** Larger size via the `size` attribute (any CSS length). */
export const Large: Story = { args: { initials: 'PM', size: '48px' } };

/** Smaller size via the `size` attribute. */
export const Small: Story = { args: { initials: 'PM', size: '22px' } };
