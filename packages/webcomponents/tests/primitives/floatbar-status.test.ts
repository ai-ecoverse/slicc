import { describe, expect, it } from 'vitest';
import {
  defaultFloatLabel,
  floatKindLabel,
  statusTipFragment,
  trayRoleIcon,
} from '../../src/primitives/floatbar-status.js';

describe('floatbar-status', () => {
  it('keeps float labels free of tray/follower encoding', () => {
    expect(defaultFloatLabel('npx')).toBe('npx');
    expect(defaultFloatLabel('extension')).toBe('extension');
    expect(floatKindLabel('sliccstart')).toBe('sliccstart');
  });

  it('builds orthogonal status tip fragments', () => {
    expect(statusTipFragment({ connection: 'live', floatKind: 'npx', trayRole: 'leader' })).toBe(
      'npx · leading tray · live'
    );
  });

  it('returns role icons only for leader/follower', () => {
    expect(trayRoleIcon('none')).toBeNull();
    expect(trayRoleIcon('leader')).toBe('crown');
    expect(trayRoleIcon('follower')).toBe('radio');
  });
});
