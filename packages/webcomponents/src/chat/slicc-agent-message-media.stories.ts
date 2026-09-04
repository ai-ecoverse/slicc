import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { SAMPLE_AUDIO, SAMPLE_VIDEO, sampleImage } from './media-fixtures.js';
import type { SliccAgentMessage } from './slicc-agent-message.js';
import './slicc-agent-message.js';

/**
 * These stories hand the component the HTML the webapp renderer produces for
 * markdown media — `packages/webapp/src/ui/message-renderer.ts`, whose
 * `image()` token emits `.msg__media` and whose `groupMediaGalleries()` wraps
 * runs of two or more in `.msg__media-gallery`. The markup is duplicated here
 * rather than imported because `webcomponents` sits below `webapp` in the
 * layer order and must not depend on it; the class names are the contract.
 *
 * In production the `src` values are `/preview/*` URLs (a bare VFS path hits
 * the SPA fallback and silently decodes HTML as an image). The fixtures use
 * data URLs so the stories stand alone.
 */

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
/**
 * Mirrors `groupMediaGalleries()` in the webapp renderer: two and four items
 * get an explicit two-column modifier, everything else rides `auto-fit`.
 * Derived from the item count rather than passed in, so a story cannot show a
 * layout the renderer would never produce.
 */
const gallery = (items: string[]) => {
  const sizing =
    items.length === 2
      ? ' msg__media-gallery--pair'
      : items.length === 4
        ? ' msg__media-gallery--quad'
        : '';
  return `<div class="msg__media-gallery${sizing}">${items.join('')}</div>`;
};

/** Build a message whose body is already-rendered markdown HTML. */
function mediaMessage(html: string, width = '520px'): SliccAgentMessage {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
  // An explicit width, not `max-width`: Storybook's root shrink-wraps its
  // subtree, and under shrink-to-fit the body collapses to the media's
  // intrinsic size — which is exactly the layout a real chat column does NOT
  // produce. Pinning the width makes the stories show the shipped behaviour.
  el.style.width = width;
  el.setBodyHtml(html);
  return el;
}

interface MediaArgs {
  /** Chat column width — the narrow end is where the gallery must reflow. */
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

/** A single image between two paragraphs — the common "here is the shot" reply. */
export const SingleImage: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Cropped the title card to 16:9 and bumped the contrast:</p>${img(FRAME_A, 'title card')}<p>The safe area still clears the lower third.</p>`,
      maxWidth
    ),
};

/** A portrait image: capped by height rules, never wider than the column. */
export const PortraitImage: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(`<p>Vertical cut for the story format:</p>${img(TALL, 'portrait cut')}`, maxWidth),
};

/**
 * A clip written as `![cut](/shared/clip/cut.mp4)`. Renders as a real player —
 * before this change `video` was absent from the DOMPurify allowlist, so the
 * element was deleted outright and the clip vanished with no error anywhere.
 */
export const SingleVideo: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Here is the assembled cut:</p>${video(SAMPLE_VIDEO, 'interview cut')}<p>Runtime is 2s; audio track is stripped.</p>`,
      maxWidth
    ),
};

/**
 * A clip written as `![vo](/shared/vo.mp3)`. Audio is control chrome rather
 * than a picture, so it spans the column and drops the media border the
 * visual elements carry.
 */
export const SingleAudio: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Voiceover take 3:</p>${audio(SAMPLE_AUDIO, 'voiceover take 3')}<p>Levels peak at -3 dB.</p>`,
      maxWidth
    ),
};

/** Two items sit side by side rather than reflowing on min-width. */
export const GalleryPair: Story = {
  render: ({ maxWidth }) =>
    mediaMessage(
      `<p>Before and after the colour pass:</p>${gallery([img(FRAME_A, 'before'), img(FRAME_B, 'after')])}`,
      maxWidth
    ),
};

/** Four frames — the batch case that motivated the grid. */
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

/** Images and a clip in one gallery — the grid does not care which is which. */
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

/**
 * The same four-up gallery in a narrow pane. The `--quad` modifier holds the
 * 2 x 2 and the tiles shrink with it, so the grid never overflows the
 * transcript. (Counts without a modifier — three, five — ride `auto-fit`
 * and drop to fewer columns instead.)
 */
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

/** Media interleaved with the rest of the GFM chrome, to check vertical rhythm. */
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
