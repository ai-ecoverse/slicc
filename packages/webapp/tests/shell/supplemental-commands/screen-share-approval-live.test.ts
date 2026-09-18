import { afterEach, describe, expect, it } from 'vitest';
import {
  beginScreenShareApproval,
  endScreenShareApproval,
  keepAdoptedScreenShare,
  resetScreenShareApprovalLiveForTests,
  shouldAdoptScreenShare,
} from '../../../src/shell/supplemental-commands/computer/screen-share-approval-live.js';

describe('screen-share approval liveness', () => {
  afterEach(() => {
    resetScreenShareApprovalLiveForTests();
  });

  it('adopts when no approval has started (terminal / tests)', () => {
    expect(shouldAdoptScreenShare()).toBe(true);
    expect(keepAdoptedScreenShare('screen1', () => true)).toBe(true);
  });

  it('drops a grant after begin+end', () => {
    beginScreenShareApproval('ui-1');
    expect(shouldAdoptScreenShare()).toBe(true);
    endScreenShareApproval('ui-1');
    expect(shouldAdoptScreenShare()).toBe(false);
    const stopped: string[] = [];
    expect(
      keepAdoptedScreenShare('screen1', (handle) => {
        stopped.push(handle);
        return true;
      })
    ).toBe(false);
    expect(stopped).toEqual(['screen1']);
  });
});
