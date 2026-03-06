// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { BRAND_EXTRACT_SCRIPT } from './brand-script.js';

function runScript(): unknown {
  return new Function(`return ${BRAND_EXTRACT_SCRIPT}`)();
}

describe('BRAND_EXTRACT_SCRIPT', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
  });

  it('is a valid JavaScript IIFE string', () => {
    expect(typeof BRAND_EXTRACT_SCRIPT).toBe('string');
    expect(() => new Function(`return ${BRAND_EXTRACT_SCRIPT}`)).not.toThrow();
  });

  it('returns expected top-level structure', () => {
    const result = runScript() as Record<string, unknown>;
    expect(result).toHaveProperty('fonts');
    expect(result).toHaveProperty('colors');
    expect(result).toHaveProperty('spacing');
    expect(result).toHaveProperty('favicons');
  });

  describe('fonts', () => {
    it('extracts body font from <p> elements', () => {
      document.body.innerHTML = '<p style="font-family: Georgia, serif">text</p>';
      const result = runScript() as Record<string, Record<string, unknown>>;
      const fonts = result.fonts as {
        body: { family: string; familySet: string };
      };
      expect(fonts.body.family).toBe('Georgia');
      expect(fonts.body.familySet).toContain('Georgia');
    });

    it('extracts heading font from <h1>', () => {
      document.body.innerHTML = '<h1 style="font-family: Impact, sans-serif">Title</h1>';
      const result = runScript() as Record<string, Record<string, unknown>>;
      const fonts = result.fonts as {
        heading: { family: string; familySet: string };
      };
      expect(fonts.heading.family).toBe('Impact');
      expect(fonts.heading.familySet).toContain('Impact');
    });

    it('returns headingSizes with all six tiers', () => {
      const result = runScript() as {
        fonts: {
          headingSizes: Record<string, { mobile: string; desktop: string }>;
        };
      };
      const tiers = ['xxl', 'xl', 'l', 'm', 's', 'xs'];
      for (const tier of tiers) {
        expect(result.fonts.headingSizes[tier]).toBeDefined();
        expect(result.fonts.headingSizes[tier]).toHaveProperty('mobile');
        expect(result.fonts.headingSizes[tier]).toHaveProperty('desktop');
      }
    });

    it('maps h1-h6 to correct tiers', () => {
      document.body.innerHTML = `
        <h1 style="font-size: 48px">H1</h1>
        <h2 style="font-size: 36px">H2</h2>
        <h3 style="font-size: 28px">H3</h3>
        <h4 style="font-size: 22px">H4</h4>
        <h5 style="font-size: 18px">H5</h5>
        <h6 style="font-size: 14px">H6</h6>
      `;
      const result = runScript() as {
        fonts: {
          headingSizes: Record<string, { mobile: string; desktop: string }>;
        };
      };
      expect(result.fonts.headingSizes.xxl.desktop).toBe('48px');
      expect(result.fonts.headingSizes.xl.desktop).toBe('36px');
      expect(result.fonts.headingSizes.l.desktop).toBe('28px');
      expect(result.fonts.headingSizes.m.desktop).toBe('22px');
      expect(result.fonts.headingSizes.s.desktop).toBe('18px');
      expect(result.fonts.headingSizes.xs.desktop).toBe('14px');
    });

    it('provides EDS default mobile sizes', () => {
      const result = runScript() as {
        fonts: {
          headingSizes: Record<string, { mobile: string; desktop: string }>;
        };
      };
      expect(result.fonts.headingSizes.xxl.mobile).toBe('36px');
      expect(result.fonts.headingSizes.xl.mobile).toBe('28px');
      expect(result.fonts.headingSizes.l.mobile).toBe('24px');
      expect(result.fonts.headingSizes.m.mobile).toBe('20px');
      expect(result.fonts.headingSizes.s.mobile).toBe('18px');
      expect(result.fonts.headingSizes.xs.mobile).toBe('16px');
    });
  });

  describe('colors', () => {
    it('extracts background and text from body', () => {
      document.body.style.backgroundColor = 'rgb(255, 255, 255)';
      document.body.style.color = 'rgb(0, 0, 0)';
      const result = runScript() as {
        colors: { background: string; text: string };
      };
      expect(result.colors.background).toContain('rgb');
      expect(result.colors.text).toContain('rgb');
    });

    it('extracts link color from first <a>', () => {
      document.body.innerHTML = '<a href="#" style="color: rgb(0, 102, 204)">link</a>';
      const result = runScript() as {
        colors: { link: string };
      };
      expect(result.colors.link).toContain('rgb');
    });

    it('returns linkHover as string or null', () => {
      const result = runScript() as {
        colors: { linkHover: string | null };
      };
      expect(
        result.colors.linkHover === null ||
        typeof result.colors.linkHover === 'string'
      ).toBe(true);
    });

    it('extracts light and dark section backgrounds', () => {
      document.body.innerHTML = `
        <section style="background-color: rgb(240, 240, 240)">Light</section>
        <section style="background-color: rgb(30, 30, 30)">Dark</section>
      `;
      const result = runScript() as {
        colors: { light: string; dark: string };
      };
      expect(result.colors.light).toContain('240');
      expect(result.colors.dark).toContain('30');
    });
  });

  describe('spacing', () => {
    it('extracts sectionPadding from <section>', () => {
      document.body.innerHTML = '<section style="padding-top: 60px">Content</section>';
      const result = runScript() as {
        spacing: { sectionPadding: string };
      };
      expect(result.spacing.sectionPadding).toBe('60px');
    });

    it('extracts navHeight from <nav>', () => {
      document.body.innerHTML = '<nav style="height: 64px">Nav</nav>';
      const result = runScript() as {
        spacing: { navHeight: string };
      };
      expect(result.spacing.navHeight).toBe('64px');
    });

    it('extracts navHeight from <header> when no <nav>', () => {
      document.body.innerHTML = '<header style="height: 80px">Header</header>';
      const result = runScript() as {
        spacing: { navHeight: string };
      };
      expect(result.spacing.navHeight).toBe('80px');
    });

    it('extracts contentMaxWidth from container', () => {
      document.body.innerHTML =
        '<main><div class="container" style="max-width: 1200px">Content</div></main>';
      const result = runScript() as {
        spacing: { contentMaxWidth: string };
      };
      expect(result.spacing.contentMaxWidth).toBe('1200px');
    });
  });

  describe('favicons', () => {
    it('extracts favicon links', () => {
      document.head.innerHTML =
        '<link rel="icon" href="/favicon.ico" type="image/x-icon">';
      const result = runScript() as {
        favicons: Array<{ url: string; rel: string; type?: string }>;
      };
      expect(result.favicons.length).toBeGreaterThanOrEqual(1);
      expect(result.favicons[0].rel).toBe('icon');
      expect(result.favicons[0].url).toContain('favicon.ico');
    });

    it('deduplicates favicon URLs', () => {
      document.head.innerHTML = `
        <link rel="icon" href="/favicon.ico">
        <link rel="icon" href="/favicon.ico">
      `;
      const result = runScript() as {
        favicons: Array<{ url: string }>;
      };
      expect(result.favicons.length).toBe(1);
    });

    it('falls back to /favicon.ico when no link tags', () => {
      document.head.innerHTML = '';
      const result = runScript() as {
        favicons: Array<{ url: string; rel: string }>;
      };
      expect(result.favicons.length).toBe(1);
      expect(result.favicons[0].url).toContain('favicon.ico');
      expect(result.favicons[0].rel).toBe('icon');
    });

    it('resolves relative URLs to absolute', () => {
      document.head.innerHTML =
        '<link rel="icon" href="assets/icon.png">';
      const result = runScript() as {
        favicons: Array<{ url: string }>;
      };
      expect(result.favicons[0].url).toMatch(/^https?:\/\//);
    });

    it('captures sizes and type attributes', () => {
      document.head.innerHTML =
        '<link rel="apple-touch-icon" href="/apple-icon.png" sizes="180x180" type="image/png">';
      const result = runScript() as {
        favicons: Array<{
          url: string;
          rel: string;
          sizes?: string;
          type?: string;
        }>;
      };
      expect(result.favicons[0].sizes).toBe('180x180');
      expect(result.favicons[0].type).toBe('image/png');
    });
  });

  describe('graceful handling of missing elements', () => {
    it('returns valid structure with empty body', () => {
      document.body.innerHTML = '';
      const result = runScript() as Record<string, unknown>;
      expect(result).toHaveProperty('fonts');
      expect(result).toHaveProperty('colors');
      expect(result).toHaveProperty('spacing');
      expect(result).toHaveProperty('favicons');
    });

    it('returns empty strings for missing spacing elements', () => {
      document.body.innerHTML = '';
      const result = runScript() as {
        spacing: {
          sectionPadding: string;
          contentMaxWidth: string;
          navHeight: string;
        };
      };
      expect(result.spacing.sectionPadding).toBe('');
      expect(result.spacing.contentMaxWidth).toBe('');
      expect(result.spacing.navHeight).toBe('');
    });

    it('returns empty heading font when no headings exist', () => {
      document.body.innerHTML = '<p>Just a paragraph</p>';
      const result = runScript() as {
        fonts: { heading: { family: string; familySet: string } };
      };
      expect(result.fonts.heading.family).toBe('');
      expect(result.fonts.heading.familySet).toBe('');
    });

    it('returns empty link color when no links exist', () => {
      document.body.innerHTML = '<p>No links here</p>';
      const result = runScript() as {
        colors: { link: string };
      };
      expect(result.colors.link).toBe('');
    });
  });
});
