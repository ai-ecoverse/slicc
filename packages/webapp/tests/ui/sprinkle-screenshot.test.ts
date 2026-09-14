import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildScreenshotSvg,
  captureSprinkleScreenshot,
  iframeScreenshotHelpersSource,
  screenshotRasteriseError,
  screenshotTargetLabel,
  screenshotZeroDimensionError,
} from '../../src/ui/sprinkle-screenshot.js';

type G = typeof globalThis & {
  window: Window & typeof globalThis;
  document: Document;
  Image: typeof Image;
  XMLSerializer: typeof XMLSerializer;
  HTMLElement: typeof HTMLElement;
  HTMLCanvasElement: typeof HTMLCanvasElement;
};

function installDom(): JSDOM {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost' });
  const g = globalThis as G;
  g.window = dom.window as unknown as Window & typeof globalThis;
  g.document = dom.window.document;
  g.Image = dom.window.Image;
  g.XMLSerializer = dom.window.XMLSerializer;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  return dom;
}

function stubCanvasContext(dom: JSDOM): void {
  const proto = dom.window.HTMLCanvasElement.prototype;
  proto.getContext = function getContext() {
    return {
      scale() {},
      drawImage() {},
    };
  } as unknown as typeof proto.getContext;
  proto.toDataURL = function toDataURL() {
    return 'data:image/png;base64,AAAA';
  };
}

function sizedRect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

function setRect(el: Element, width: number, height: number): void {
  el.getBoundingClientRect = () => sizedRect(width, height);
}

class ErrorImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

describe('screenshot error formatters', () => {
  it('names document.body and a fractional WxH', () => {
    expect(screenshotZeroDimensionError('document.body', 1072.4, 0)).toBe(
      'Element has zero dimensions (document.body, 1072.4x0)'
    );
  });

  it('names a selector and 0x0', () => {
    expect(screenshotZeroDimensionError('#foo', 0, 0)).toBe(
      'Element has zero dimensions (#foo, 0x0)'
    );
  });

  it('labels a selector, the body, or the fragment container', () => {
    expect(screenshotTargetLabel('#foo', null)).toBe('#foo');
    expect(screenshotTargetLabel(undefined, undefined)).toBe('container');
  });

  it('labels document.body when that is the measured target', () => {
    const dom = installDom();
    try {
      expect(screenshotTargetLabel(undefined, document.body)).toBe('document.body');
    } finally {
      dom.window.close();
    }
  });

  it('names decode failure with rect and byte lengths', () => {
    const msg = screenshotRasteriseError(
      'image decode failed',
      'document.body',
      1072,
      565,
      12345,
      23456
    );
    expect(msg).toContain('image decode failed');
    expect(msg).toContain('document.body 1072x565');
    expect(msg).toContain('serialised SVG 12345 bytes');
    expect(msg).toContain('data URL 23456 bytes');
    expect(msg).not.toBe('Screenshot rendering failed');
  });

  it('names a serializer throw', () => {
    expect(screenshotRasteriseError('XMLSerializer threw: boom', 'container', 10, 10)).toContain(
      'XMLSerializer threw: boom'
    );
  });

  it('wraps serialised HTML in an XHTML foreignObject', () => {
    const svg = buildScreenshotSvg('<p>hi</p>', 10, 20);
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain('<foreignObject width="100%" height="100%"');
    expect(svg).toContain('<p>hi</p>');
  });
});

describe('iframeScreenshotHelpersSource', () => {
  it('embeds the shared formatters under known names', () => {
    const src = iframeScreenshotHelpersSource();
    expect(src).toContain('var screenshotTargetLabel = ');
    expect(src).toContain('var screenshotZeroDimensionError = ');
    expect(src).toContain('var screenshotRasteriseError = ');
    expect(src).toContain('var buildScreenshotSvg = ');
    expect(src).toContain('Element has zero dimensions');
    expect(src).toContain('Screenshot rendering failed');
    expect(src).toContain('http://www.w3.org/1999/xhtml');
  });
});

describe('captureSprinkleScreenshot', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.window.close();
  });

  it('rejects zero-size document.body with selector-or-body and WxH', async () => {
    setRect(document.body, 1072.4, 0);
    await expect(captureSprinkleScreenshot()).rejects.toThrow(
      'Element has zero dimensions (document.body, 1072.4x0)'
    );
  });

  it('rejects a zero-size selector with #id and 0x0', async () => {
    const foo = document.createElement('div');
    foo.id = 'foo';
    setRect(foo, 0, 0);
    document.body.appendChild(foo);
    await expect(captureSprinkleScreenshot('#foo')).rejects.toThrow(
      'Element has zero dimensions (#foo, 0x0)'
    );
  });

  it('keeps Element not found: #no-such-element', async () => {
    setRect(document.body, 100, 100);
    await expect(captureSprinkleScreenshot('#no-such-element')).rejects.toThrow(
      'Element not found: #no-such-element'
    );
  });

  it('names image decode failed (not only Screenshot rendering failed) on img.onerror', async () => {
    stubCanvasContext(dom);
    const origImage = globalThis.Image;
    (globalThis as G).Image = ErrorImage as unknown as typeof Image;
    setRect(document.body, 1072.4, 565);
    try {
      let message = '';
      try {
        await captureSprinkleScreenshot();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('image decode failed');
      expect(message).toContain('document.body 1073x565');
      expect(message).toMatch(/serialised SVG \d+ bytes/);
      expect(message).toMatch(/data URL \d+ bytes/);
      expect(message).toMatch(/^Screenshot rendering failed \(/);
      expect(message).not.toBe('Screenshot rendering failed');
    } finally {
      (globalThis as G).Image = origImage;
    }
  });

  it('names an XMLSerializer throw', async () => {
    stubCanvasContext(dom);
    setRect(document.body, 80, 40);
    const orig = globalThis.XMLSerializer;
    (globalThis as G).XMLSerializer = class {
      serializeToString(): string {
        throw new Error('unescaped ampersand');
      }
    } as unknown as typeof XMLSerializer;
    try {
      await expect(captureSprinkleScreenshot()).rejects.toThrow(
        /XMLSerializer threw: unescaped ampersand/
      );
    } finally {
      (globalThis as G).XMLSerializer = orig;
    }
  });
});
