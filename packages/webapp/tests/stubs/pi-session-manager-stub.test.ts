import { describe, expect, it } from 'vitest';
import {
  buildSessionContext,
  sessionEntryToContextMessages,
} from '../../src/stubs/pi-session-manager-stub.js';

describe('pi session manager browser stub', () => {
  it.each([
    ['buildSessionContext', buildSessionContext],
    ['sessionEntryToContextMessages', sessionEntryToContextMessages],
  ])('fails closed when %s is called', (name, fn) => {
    expect(fn).toThrow(`${name} is not available in the browser`);
  });
});
