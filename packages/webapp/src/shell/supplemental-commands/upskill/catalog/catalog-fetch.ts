/**
 * upskill — skill catalog HTTP fetchers.
 *
 * Extracted verbatim from `upskill-command.ts`. `describeFetchError` is still
 * defined in the monolith (it backs every net boundary in the command, not
 * just the catalog) and imported back here; this is a runtime-safe,
 * function-only import cycle that a later wave can collapse by moving the net
 * helpers into their own module.
 */

import type { SecureFetch } from 'just-bash';
import { parseFetchJson } from '../../../fetch-body.js';
import { describeFetchError } from '../../upskill-command.js';
import type { CatalogSkill, RemoteCatalogRow } from '../types.js';
import { SKILL_CATALOG_BASE_URL, SKILL_CATALOG_URL } from '../types.js';
import { parseRemoteCatalog, slugifyCompany } from './catalog.js';

/**
 * Fetch the per-company skill catalog (`/skills/<slug>.json`). Returns `[]`
 * on any failure — a missing or broken company catalog must not block the
 * primary recommendation flow.
 */
export async function fetchCompanyCatalog(
  fetchFn: SecureFetch,
  company: unknown
): Promise<CatalogSkill[]> {
  try {
    const slug = slugifyCompany(company);
    if (!slug) return [];
    const response = await fetchFn(`${SKILL_CATALOG_BASE_URL}${slug}.json`, {
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) return [];
    const data = parseFetchJson<{ data: RemoteCatalogRow[] }>(response.body);
    return parseRemoteCatalog(data.data);
  } catch {
    return [];
  }
}

export async function fetchGlobalCatalog(fetchFn: SecureFetch): Promise<CatalogSkill[]> {
  let response;
  try {
    response = await fetchFn(SKILL_CATALOG_URL, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(describeFetchError(err, SKILL_CATALOG_URL));
  }
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const data = parseFetchJson<{ data: RemoteCatalogRow[] }>(response.body);
  return parseRemoteCatalog(data.data);
}
