/**
 * Shared ImageMagick WASM initialization module.
 *
 * Extracted from convert-command.ts so both `convert` and `image-processor`
 * can reuse the same cached WASM instance. Handles dual-mode loading:
 * - CLI/browser: CDN or local node_modules
 * - Extension: bundled magick.wasm via chrome.runtime.getURL
 */

export interface ImageMagickModule {
  initializeImageMagick: (wasmLocation: URL | Uint8Array) => Promise<void>;
  ImageMagick: {
    read: (data: Uint8Array, callback: (image: IMagickImage) => Promise<void>) => Promise<void>;
  };
  MagickFormat: Record<string, string>;
  MagickGeometry: {
    new (value: string): IMagickGeometry;
    new (widthAndHeight: number): IMagickGeometry;
    new (width: number, height: number): IMagickGeometry;
  };
  Percentage: new (value: number) => { toDouble(): number };
}

export interface IMagickGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
  isPercentage: boolean;
  ignoreAspectRatio: boolean;
}

export interface IMagickImage {
  resize(width: number, height: number): void;
  resize(geometry: IMagickGeometry): void;
  rotate(degrees: number): void;
  crop(geometry: IMagickGeometry): void;
  crop(width: number, height: number): void;
  quality: number;
  width: number;
  height: number;
  write(format: string, callback: (data: Uint8Array) => void): void;
  write(callback: (data: Uint8Array) => void): void;
}

/** MIME type to ImageMagick format string mapping. Single source of truth. */
export const MIME_TO_MAGICK_FORMAT: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
  'image/avif': 'AVIF',
};

let magickPromise: Promise<ImageMagickModule> | null = null;
export const MAGICK_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.38/dist/';
export const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

export async function getMagick(): Promise<ImageMagickModule> {
  if (!magickPromise) {
    magickPromise = (async () => {
      try {
        const magickModule = await import('@imagemagick/magick-wasm');
        if (isExtension) {
          // Chrome extension — fetch bundled WASM as bytes
          // initializeImageMagick rejects chrome-extension:// URLs, so pass Uint8Array
          const wasmUrl = chrome.runtime.getURL('magick.wasm');
          const resp = await fetch(wasmUrl);
          if (!resp.ok) {
            throw new Error(`Failed to fetch magick.wasm: ${resp.status} ${resp.statusText}`);
          }
          const wasmBytes = new Uint8Array(await resp.arrayBuffer());
          await magickModule.initializeImageMagick(wasmBytes);
        } else {
          const wasmBase =
            typeof window === 'undefined'
              ? new URL(
                  '../../../node_modules/@imagemagick/magick-wasm/dist/',
                  import.meta.url
                ).toString()
              : MAGICK_WASM_CDN;
          const wasmUrl = new URL('magick.wasm', wasmBase);
          await magickModule.initializeImageMagick(wasmUrl);
        }

        return magickModule as unknown as ImageMagickModule;
      } catch (err) {
        // Reset so subsequent calls retry instead of returning the rejected promise
        magickPromise = null;
        throw err;
      }
    })();
  }
  return magickPromise;
}
