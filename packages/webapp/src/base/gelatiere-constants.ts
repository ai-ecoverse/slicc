export const GELATIERE_FOLDER = 'gelatiere';

export const GELATIERE_SPRINKLE_NAME = 'gelatiere';

export const GELATIERE_NIGHTLY_CRON_NAME = 'gelatiere-nightly';

export const GELATIERE_OWNER_JID = 'system:gelatiere';

export function isGelatiereUnit(scoop: { parentJid: string | null; folder: string }): boolean {
  return scoop.parentJid === GELATIERE_OWNER_JID && scoop.folder === GELATIERE_FOLDER;
}
