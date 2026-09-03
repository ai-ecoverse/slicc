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

  it('rejects join URLs whose token is not exactly <trayId>.<secret>', () => {
    // A follower that accepts a malformed token would dial a tray it cannot
    // authenticate to, so every shape but the two-part one must be refused.
    const bad = [
      'https://tray.example.com/join/tray-join', // no secret
      'https://tray.example.com/join/.secret', // no trayId
      'https://tray.example.com/join/tray-join.', // empty secret
      'https://tray.example.com/join/tray-join.secret.extra', // third part
    ];
    for (const raw of bad) expect(parseTrayJoinUrl(raw)).toBeNull();
  });

  it('returns null for unparseable input rather than throwing', () => {
    // Callers read these straight off `location`/argv, so a garbage value has
    // to come back as null, not blow up the boot path.
    for (const raw of ['not-a-url', 'join/tray-join.secret', '', null, undefined]) {
      expect(parseTrayJoinUrl(raw)).toBeNull();
      expect(normalizeTrayWorkerBaseUrl(raw)).toBeNull();
    }
  });

  it('parses a join URL served from the worker root', () => {
    expect(parseTrayJoinUrl('https://tray.example.com/join/tray-join.secret')).toEqual({
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-join',
      joinUrl: 'https://tray.example.com/join/tray-join.secret',
    });
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
