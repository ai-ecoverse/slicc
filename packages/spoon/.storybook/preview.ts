import type { Decorator, Preview } from '@storybook/web-components-vite';

/**
 * Theme decorator — the launcher is light-default and flips to dark via a
 * `dark` class on <body> plus a `data-theme` attribute on the document root
 * (matching the host app). The launcher's shadow STYLE references design tokens
 * (`var(--canvas, …)`) with built-in fallbacks, so it renders standalone here
 * without the full token sheet.
 */
const withTheme: Decorator = (story, context) => {
  const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
  document.body.classList.toggle('dark', theme === 'dark');
  document.documentElement.setAttribute('data-theme', theme);
  return story();
};

const preview: Preview = {
  initialGlobals: {
    theme: 'light',
  },
  globalTypes: {
    theme: {
      description: 'Light / dark mode',
      toolbar: {
        title: 'Theme',
        icon: 'contrast',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [withTheme],
  parameters: {
    layout: 'fullscreen',
  },
};

export default preview;
