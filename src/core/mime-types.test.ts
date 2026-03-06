import { describe, it, expect } from 'vitest';
import {
  getMimeType,
  isImageMimeType,
  isTerminalPreviewableMediaPath,
  isTerminalPreviewableMimeType,
  isVideoMimeType,
} from './mime-types.js';

describe('getMimeType', () => {
  it('returns correct MIME for common web types', () => {
    expect(getMimeType('index.html')).toBe('text/html');
    expect(getMimeType('style.css')).toBe('text/css');
    expect(getMimeType('app.js')).toBe('application/javascript');
    expect(getMimeType('data.json')).toBe('application/json');
  });

  it('handles image types', () => {
    expect(getMimeType('logo.png')).toBe('image/png');
    expect(getMimeType('photo.jpg')).toBe('image/jpeg');
    expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
    expect(getMimeType('icon.svg')).toBe('image/svg+xml');
    expect(getMimeType('anim.gif')).toBe('image/gif');
    expect(getMimeType('hero.webp')).toBe('image/webp');
    expect(getMimeType('still.avif')).toBe('image/avif');
  });

  it('handles font types', () => {
    expect(getMimeType('font.woff')).toBe('font/woff');
    expect(getMimeType('font.woff2')).toBe('font/woff2');
    expect(getMimeType('font.ttf')).toBe('font/ttf');
  });

  it('handles full paths', () => {
    expect(getMimeType('/workspace/my-app/index.html')).toBe('text/html');
    expect(getMimeType('/workspace/my-app/assets/style.css')).toBe('text/css');
  });

  it('is case insensitive via lowercase extension', () => {
    expect(getMimeType('FILE.HTML')).toBe('text/html');
    expect(getMimeType('STYLE.CSS')).toBe('text/css');
    expect(getMimeType('app.JS')).toBe('application/javascript');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(getMimeType('data.xyz')).toBe('application/octet-stream');
    expect(getMimeType('file.unknown')).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for files without extension', () => {
    expect(getMimeType('Makefile')).toBe('application/octet-stream');
  });

  it('handles .htm as text/html', () => {
    expect(getMimeType('page.htm')).toBe('text/html');
  });

  it('handles media types', () => {
    expect(getMimeType('song.mp3')).toBe('audio/mpeg');
    expect(getMimeType('video.mp4')).toBe('video/mp4');
    expect(getMimeType('clip.webm')).toBe('video/webm');
    expect(getMimeType('movie.mov')).toBe('video/quicktime');
  });

  it('handles wasm', () => {
    expect(getMimeType('module.wasm')).toBe('application/wasm');
  });

  it('identifies previewable terminal media', () => {
    expect(isImageMimeType('image/png')).toBe(true);
    expect(isVideoMimeType('video/webm')).toBe(true);
    expect(isTerminalPreviewableMimeType('image/webp')).toBe(true);
    expect(isTerminalPreviewableMimeType('video/mp4')).toBe(true);
    expect(isTerminalPreviewableMimeType('text/plain')).toBe(false);
    expect(isTerminalPreviewableMediaPath('/workspace/assets/photo.jpg')).toBe(true);
    expect(isTerminalPreviewableMediaPath('/workspace/assets/clip.webm')).toBe(true);
    expect(isTerminalPreviewableMediaPath('/workspace/README.md')).toBe(false);
  });
});
