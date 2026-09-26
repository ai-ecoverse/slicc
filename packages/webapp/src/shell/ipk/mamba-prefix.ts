/**
 * VFS locations for `ipk mamba` conda/emscripten-forge installs.
 *
 * Mirrors the npm global layout under `/shared/lib`: npm packages live in
 * `/shared/lib/node_modules`, conda env prefix lives in `/shared/lib/conda`
 * (with the usual `lib/`, `include/`, `bin/`, `conda-meta/` layout inside).
 */

/** Conda environment prefix for shared (global) mamba installs. */
export const CONDA_PREFIX = '/shared/lib/conda';

/** Directory of conda-meta JSON records for installed packages. */
export const CONDA_META_DIR = `${CONDA_PREFIX}/conda-meta`;

/** Default platform for emscripten-forge packages. */
export const CONDA_PLATFORM = 'emscripten-wasm32';

/**
 * Default channels (in priority order). emscripten-forge first for
 * `emscripten-wasm32` builds; conda-forge for noarch companions.
 */
export const DEFAULT_CONDA_CHANNELS = [
  'https://repo.prefix.dev/emscripten-forge-4x',
  'https://repo.prefix.dev/conda-forge',
] as const;

/** Hosts SecureFetch may download repodata / packages from. */
export const ALLOWED_CONDA_HOSTS = new Set(['repo.prefix.dev', 'prefix.dev']);
