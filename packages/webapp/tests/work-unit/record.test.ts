import { describe, expect, it } from 'vitest';
import {
  chatSessionIdFor,
  coneFolderFor,
  isPrimaryRoot,
  legacyRecordIsCone,
  normalizeScoopRecord,
  PRIMARY_CONE_FOLDER,
  processOwnerKindFor,
  slugifyUnitName,
  sourceLabelFor,
} from '../../src/work-unit/record.js';
import { childRecord, rootRecord, withLegacyRoleFields } from './fixtures.js';

describe('work-unit record helpers', () => {
  it('keys chat sessions by folder so the primary cone keeps session-cone', () => {
    expect(chatSessionIdFor(rootRecord({ folder: 'cone' }))).toBe('session-cone');
    expect(chatSessionIdFor(rootRecord({ folder: 'cone-research' }))).toBe('session-cone-research');
    expect(chatSessionIdFor(childRecord('cone_1', { folder: 'worker-scoop' }))).toBe(
      'session-worker-scoop'
    );
  });

  it('identifies the primary root by folder, not by age or label', () => {
    expect(isPrimaryRoot(rootRecord({ folder: PRIMARY_CONE_FOLDER }))).toBe(true);
    expect(isPrimaryRoot(rootRecord({ folder: 'cone-two' }))).toBe(false);
    expect(isPrimaryRoot(childRecord('cone_1', { folder: 'cone' }))).toBe(false);
  });

  it('slugifies user-typed names', () => {
    expect(slugifyUnitName('Research Cone')).toBe('research-cone');
    expect(slugifyUnitName('  Ünïcode!! ')).toBe('unicode');
    expect(slugifyUnitName('Café Ölçü')).toBe('cafe-olcu');
    expect(slugifyUnitName('--foo--')).toBe('foo');
    expect(slugifyUnitName('***')).toBe('cone');
    expect(slugifyUnitName('x'.repeat(80))).toHaveLength(40);
  });

  it('allocates the primary folder first, then unique cone-<slug> folders', () => {
    expect(coneFolderFor('Cone', [])).toBe('cone');
    const primary = rootRecord({ folder: 'cone' });
    expect(coneFolderFor('Research', [primary])).toBe('cone-research');
    const research = rootRecord({ jid: 'cone_2', folder: 'cone-research' });
    expect(coneFolderFor('Research', [primary, research])).toBe('cone-research-2');
    expect(
      coneFolderFor('Research', [
        primary,
        research,
        rootRecord({ jid: 'c3', folder: 'cone-research-2' }),
      ])
    ).toBe('cone-research-3');
    // a scoop holding the folder counts too — folders are one namespace
    expect(coneFolderFor('worker-scoop', [primary, childRecord('cone_1')])).toBe(
      'cone-worker-scoop'
    );
  });

  it('derives presentation labels from the edge', () => {
    expect(processOwnerKindFor(rootRecord())).toBe('cone');
    expect(processOwnerKindFor(childRecord('cone_1'))).toBe('scoop');
    expect(sourceLabelFor(rootRecord({ folder: 'cone-two', name: 'Two' }))).toBe('cone');
    expect(sourceLabelFor(childRecord('cone_1', { folder: 'w' }))).toBe('w');
  });

  // #2279: `isCone` / `type` are gone from the record, but a profile written
  // before that still has them on disk. Restore must read them once (to
  // anchor the `parentJid` backfill) and then leave nothing behind.
  describe('legacy persisted records', () => {
    it('reads the pre-#2279 cone flag for the restore backfill', () => {
      expect(
        legacyRecordIsCone(withLegacyRoleFields(rootRecord(), { isCone: true, type: 'cone' }))
      ).toBe(true);
      expect(
        legacyRecordIsCone(
          withLegacyRoleFields(childRecord('cone_1'), { isCone: false, type: 'scoop' })
        )
      ).toBe(false);
      // A record already migrated carries neither field.
      expect(legacyRecordIsCone(rootRecord())).toBe(false);
    });

    it('normalizeScoopRecord tolerates and strips them, keeping everything else', () => {
      const legacy = withLegacyRoleFields(
        childRecord('cone_1', { folder: 'worker-scoop', assistantLabel: 'worker-scoop' }),
        { isCone: false, type: 'scoop' }
      );
      const normalized = normalizeScoopRecord(legacy);
      expect(normalized).toBe(legacy);
      expect(normalized).not.toHaveProperty('isCone');
      expect(normalized).not.toHaveProperty('type');
      expect(normalized).toMatchObject({
        jid: legacy.jid,
        parentJid: 'cone_1',
        folder: 'worker-scoop',
        trigger: '@worker-scoop',
        requiresTrigger: true,
        assistantLabel: 'worker-scoop',
      });
    });
  });

  it('strips onParentClose from a root — the field is a child concept', () => {
    const promoted = normalizeScoopRecord(
      childRecord('cone_1', { parentJid: null, onParentClose: 'detach' })
    );
    expect(promoted.parentJid).toBeNull();
    expect(promoted.onParentClose).toBeUndefined();
    expect(promoted.trigger).toBeUndefined();
    expect(promoted.requiresTrigger).toBe(false);
  });
});
