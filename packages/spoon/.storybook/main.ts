import type { StorybookConfig } from '@storybook/web-components-vite';

/**
 * Storybook is the visual-isolation surface for the spoon launcher overlay.
 * The single `slicc-launcher.stories.ts` renders its follower-status states;
 * the theme toolbar (see preview.ts) drives light/dark.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.ts'],
  framework: {
    name: '@storybook/web-components-vite',
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
};

export default config;
