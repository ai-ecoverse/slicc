export const CONDA_PREFIX = '/shared/lib/conda';

export const CONDA_META_DIR = `${CONDA_PREFIX}/conda-meta`;

export const CONDA_PLATFORM = 'emscripten-wasm32';

export const DEFAULT_CONDA_CHANNELS = [
  'https://repo.prefix.dev/emscripten-forge-4x',
  'https://repo.prefix.dev/conda-forge',
] as const;

export const ALLOWED_CONDA_HOSTS = new Set(['repo.prefix.dev', 'prefix.dev']);
