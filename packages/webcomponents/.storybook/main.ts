import type { StorybookConfig } from '@storybook/web-components-vite';

/**
 * Storybook is the visual-isolation surface for the SLICC web components.
 * Every component ships a `<name>.stories.ts` co-located in src/ rendering its
 * states; the theme toolbar (see preview.ts) drives light/dark and the viewport
 * toolbar drives the screen-size matrix.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.ts'],
  // Local, dev-only feedback addon (manager panel). Resolved to an absolute
  // path so Storybook 10 loads it as a preset that registers the manager entry.
  addons: [import.meta.resolve('./feedback-addon/preset.ts')],
  framework: {
    name: '@storybook/web-components-vite',
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
};

export default config;
