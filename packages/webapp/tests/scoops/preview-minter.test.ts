import { beforeEach, describe, expect, it } from 'vitest';
import {
  getPreviewMinter,
  type PreviewMinter,
  setPreviewMinter,
} from '../../src/scoops/preview-minter.js';

beforeEach(() => setPreviewMinter(null));

describe('preview-minter hook', () => {
  it('returns null when no minter is registered', () => {
    expect(getPreviewMinter()).toBeNull();
  });

  it('returns the registered minter', () => {
    const minter: PreviewMinter = async () => ({ url: 'x', pushed: 0 });
    setPreviewMinter(minter);
    expect(getPreviewMinter()).toBe(minter);
  });

  it('clears on null', () => {
    setPreviewMinter(async () => ({ url: 'x', pushed: 0 }));
    setPreviewMinter(null);
    expect(getPreviewMinter()).toBeNull();
  });
});
