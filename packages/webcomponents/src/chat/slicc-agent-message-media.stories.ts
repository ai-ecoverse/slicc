import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { SAMPLE_AUDIO, SAMPLE_VIDEO, sampleImage } from './media-fixtures.js';
import type { SliccAgentMessage } from './slicc-agent-message.js';
import './slicc-agent-message.js';

const FRAME_A = sampleImage('frame 001', '#6366f1', '#8b5cf6');
const FRAME_B = sampleImage('frame 002', '#06b6d4', '#0ea5e9');
const FRAME_C = sampleImage('frame 003', '#f43f5e', '#fb7185');
const FRAME_D = sampleImage('frame 004', '#f59e0b', '#fbbf24');
const TALL = sampleImage('portrait', '#10b981', '#34d399', 400, 640);

const img = (src: string, alt: string) =>
  `<img class="msg__media msg__media--image" src="${src}" alt="${alt}">`;
const video = (src: string, label: string) =>
  `<video class="msg__media msg__media--video" src="${src}" aria-label="${label}" controls preload="metadata" playsinline></video>`;
const audio = (src: string, label: string) =>
  `<audio class="msg__media msg__media--audio" src="${src}" aria-label="${label}" controls preload="metadata"></audio>`;

const gallery = (items: string[]) => {
  const sizing =
    items.length === 2
      ? ' msg__media-gallery--pair'
      : items.length === 4
        ? ' msg__media-gallery--quad'
        : '';
  return `<div class="msg__media-gallery${sizing}">${items.join('')}</div>`;
};

function mediaMessage(html: string, width = '520px'): SliccAgentMessage {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;

  el.style.width = width;
  el.setBodyHtml(html);
  return el;
}

interface MediaArgs {
  maxWidth: string;
}

const meta: Meta<MediaArgs> = {
  title: 'Chat/AgentMessage Media',
  component: 'slicc-agent-message',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Images and video written as plain markdown `![alt](path)` in an assistant ' +
          'message. One syntax carries all three: the file extension decides whether ' +
          'the renderer emits an `<img>`, a `<video controls>` or an `<audio controls>`. ' +
          'Two or more adjacent ' +
          'items become a gallery grid so a batch of frames stays glanceable.',
      },
    },
  },
  argTypes: {
    maxWidth: { control: 'text', description: 'Chat column width' },
  },
  args: { maxWidth: '520px' },
};

export default meta;
type Story = StoryObj<MediaArgs>;

export const SingleImage: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Cropped the title card to 16:9 and bumped the contrast:</p>${img(FRAME_A, 'title card')}<p>The safe area still clears the lower third.</p>`,
      maxWidth
    ),
};

export const PortraitImage: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(`<p>Vertical cut for the story format:</p>${img(TALL, 'portrait cut')}`, maxWidth),
};

export const SingleVideo: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Here is the assembled cut:</p>${video(SAMPLE_VIDEO, 'interview cut')}<p>Runtime is 2s; audio track is stripped.</p>`,
      maxWidth
    ),
};

export const SingleAudio: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Voiceover take 3:</p>${audio(SAMPLE_AUDIO, 'voiceover take 3')}<p>Levels peak at -3 dB.</p>`,
      maxWidth
    ),
};

export const GalleryPair: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Before and after the colour pass:</p>${gallery([img(FRAME_A, 'before'), img(FRAME_B, 'after')])}`,
      maxWidth
    ),
};

export const GalleryFour: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Four candidate thumbnails:</p>${gallery([
        img(FRAME_A, 'candidate 1'),
        img(FRAME_B, 'candidate 2'),
        img(FRAME_C, 'candidate 3'),
        img(FRAME_D, 'candidate 4'),
      ])}<p>Second one holds up best at 96px.</p>`,
      maxWidth
    ),
};

export const GalleryMixed: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Stills plus the moving version:</p>${gallery([
        img(FRAME_C, 'still'),
        video(SAMPLE_VIDEO, 'clip'),
        img(FRAME_D, 'still'),
      ])}`,
      maxWidth
    ),
};

export const GalleryNarrowColumn: Story = {
  args: { maxWidth: '260px' },
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Four candidates, narrow pane:</p>${gallery([
        img(FRAME_A, 'candidate 1'),
        img(FRAME_B, 'candidate 2'),
        img(FRAME_C, 'candidate 3'),
        img(FRAME_D, 'candidate 4'),
      ])}`,
      maxWidth
    ),
};

export const MediaInProse: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<h3>Render report</h3><p>Encoded three variants. The VP8 build is the smallest:</p>` +
        `<table><thead><tr><th>Codec</th><th>Size</th></tr></thead><tbody>` +
        `<tr><td>h264</td><td>6.1 kB</td></tr><tr><td>vp8</td><td>4.4 kB</td></tr></tbody></table>` +
        `${video(SAMPLE_VIDEO, 'h264 build')}` +
        `<p>Frames pulled at <code>00:00.5</code> and <code>00:01.5</code>:</p>` +
        `${gallery([img(FRAME_B, 'frame at 0.5s'), img(FRAME_C, 'frame at 1.5s')])}` +
        `<blockquote>Both frames clear the 120px poster threshold.</blockquote>`,
      maxWidth
    ),
};
