import { describe, expect, it } from 'vitest';
import { deviceLabel, labelDevices, shouldShowDevicePicker } from '../../src/composer/devices.js';

describe('devices (shared composer picker helpers)', () => {
  describe('deviceLabel', () => {
    it('returns the trimmed label when present', () => {
      expect(deviceLabel('FaceTime HD', 0, 'camera')).toBe('FaceTime HD');
      expect(deviceLabel('  USB Condenser  ', 1, 'microphone')).toBe('USB Condenser');
    });

    it('falls back to a 1-indexed positional placeholder per kind', () => {
      expect(deviceLabel('', 0, 'camera')).toBe('Camera 1');
      expect(deviceLabel(null, 1, 'camera')).toBe('Camera 2');
      expect(deviceLabel(undefined, 0, 'microphone')).toBe('Microphone 1');
      expect(deviceLabel('   ', 2, 'microphone')).toBe('Microphone 3');
    });
  });

  describe('labelDevices', () => {
    it('normalizes a mixed list, preserving input order and ids', () => {
      const out = labelDevices(
        [
          { deviceId: 'a', label: 'Alpha' },
          { deviceId: 'b', label: '' },
          { deviceId: 'c', label: null },
          { deviceId: 'd' },
        ],
        'camera'
      );
      expect(out).toEqual([
        { deviceId: 'a', label: 'Alpha' },
        { deviceId: 'b', label: 'Camera 2' },
        { deviceId: 'c', label: 'Camera 3' },
        { deviceId: 'd', label: 'Camera 4' },
      ]);
    });

    it('uses the microphone placeholder when kind is microphone', () => {
      const out = labelDevices(
        [
          { deviceId: 'm1', label: '' },
          { deviceId: 'm2', label: 'Studio Mic' },
        ],
        'microphone'
      );
      expect(out).toEqual([
        { deviceId: 'm1', label: 'Microphone 1' },
        { deviceId: 'm2', label: 'Studio Mic' },
      ]);
    });

    it('returns an empty array for an empty input', () => {
      expect(labelDevices([], 'camera')).toEqual([]);
      expect(labelDevices([], 'microphone')).toEqual([]);
    });
  });

  describe('shouldShowDevicePicker', () => {
    it('is false for 0 or 1 devices, true for 2+', () => {
      expect(shouldShowDevicePicker([])).toBe(false);
      expect(shouldShowDevicePicker([{}])).toBe(false);
      expect(shouldShowDevicePicker([{}, {}])).toBe(true);
      expect(shouldShowDevicePicker([{}, {}, {}])).toBe(true);
    });

    it('accepts any ArrayLike (length-only), not just arrays', () => {
      expect(shouldShowDevicePicker({ length: 0 })).toBe(false);
      expect(shouldShowDevicePicker({ length: 1 })).toBe(false);
      expect(shouldShowDevicePicker({ length: 2 })).toBe(true);
    });
  });
});
