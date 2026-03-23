import { describe, expect, it } from 'vitest';

import {
  buildCanonicalTrayLaunchUrl,
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrl,
} from '../src/tray-url-shared.js';

describe('tray-url-shared', () => {
  it('normalizes tray worker base URLs consistently', () => {
    expect(normalizeTrayWorkerBaseUrl('https://tray.example.com/')).toBe(
      'https://tray.example.com'
    );
    expect(normalizeTrayWorkerBaseUrl('https://tray.example.com/base///')).toBe(
      'https://tray.example.com/base'
    );
    expect(normalizeTrayWorkerBaseUrl('not-a-url')).toBeNull();
  });

  it('parses tray join URLs and strips query/hash noise', () => {
    expect(
      parseTrayJoinUrl('https://tray.example.com/base/join/tray-join.secret?via=share#copied')
    ).toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-join',
      joinUrl: 'https://tray.example.com/base/join/tray-join.secret',
    });
    expect(parseTrayJoinUrl('https://tray.example.com/base/tray/tray-123')).toBeNull();
  });

  it('builds canonical tray launch URLs and removes legacy params', () => {
    expect(
      buildCanonicalTrayLaunchUrl(
        'http://localhost:3000/?scoop=cone&trayWorkerUrl=https://old.example.com&lead=https://older.example.com',
        'https://tray.example.com/base/join/tray-join.secret'
      )
    ).toBe(
      'http://localhost:3000/?scoop=cone&tray=https%3A%2F%2Ftray.example.com%2Fbase%2Fjoin%2Ftray-join.secret'
    );
  });
});
