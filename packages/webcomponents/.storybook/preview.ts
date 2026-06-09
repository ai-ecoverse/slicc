import type { Decorator, Preview } from '@storybook/web-components-vite';
import '../src/theme/tokens.css';

/**
 * Theme decorator — the prototype is light-default and flips to dark via a
 * `dark` class on <body> (see project decision: prototype token polarity is the
 * lib contract). We mirror that here and also forward a `theme` attribute to the
 * document root so shadow-DOM components that honor `[theme]` (slicc-pill,
 * slicc-add-menu) stay in sync with the toolbar.
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
    layout: 'centered',
    viewport: {
      options: {
        narrow: { name: 'Narrow (mobile)', styles: { width: '390px', height: '780px' } },
        medium: { name: 'Medium (tablet)', styles: { width: '768px', height: '900px' } },
        wide: { name: 'Wide (desktop)', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
};

export default preview;
