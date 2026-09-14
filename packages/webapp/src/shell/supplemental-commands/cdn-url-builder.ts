export const UNPKG_HOST = ['unpkg', 'com'].join('.');
export const JSDELIVR_HOST = ['cdn', 'jsdelivr', 'net'].join('.');
export const REGISTRY_NPMJS_HOST = ['registry', 'npmjs', 'org'].join('.');

export function buildCdnUrl(host: string, path: string): URL {
  return new URL(path, `https://${host}`);
}

export function unpkgUrl(pkg: string, version?: string, file?: string): URL {
  const versionPart = version ? `@${version}` : '';
  const filePart = file ? `/${file.replace(/^\/+/, '')}` : '';
  return buildCdnUrl(UNPKG_HOST, `/${pkg}${versionPart}${filePart}`);
}

const NPM_NAME_SEGMENT = /^[A-Za-z0-9~][A-Za-z0-9._~-]*$/;

const MAX_NPM_NAME_LENGTH = 214;

export function validateNpmPackageName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Invalid npm package name: must be a non-empty string');
  }
  if (name.length > MAX_NPM_NAME_LENGTH) {
    throw new Error(
      `Invalid npm package name: '${name}' exceeds ${MAX_NPM_NAME_LENGTH} characters`
    );
  }
  if (name !== name.trim()) {
    throw new Error(`Invalid npm package name: '${name}' has leading or trailing whitespace`);
  }
  if (/[\u0000-\u001f\u007f\s]/.test(name)) {
    throw new Error(
      `Invalid npm package name: '${name}' contains control characters or whitespace`
    );
  }
  if (name.includes('..')) {
    throw new Error(`Invalid npm package name: '${name}' contains '..'`);
  }
  if (name.startsWith('/')) {
    throw new Error(`Invalid npm package name: '${name}' starts with '/'`);
  }
  if (name.startsWith('.') || name.startsWith('_')) {
    throw new Error(`Invalid npm package name: '${name}' cannot start with '.' or '_'`);
  }

  let local: string;
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash === -1) {
      throw new Error(
        `Invalid npm package name: scoped name '${name}' is missing the required '/'`
      );
    }
    if (name.indexOf('/', slash + 1) !== -1) {
      throw new Error(
        `Invalid npm package name: scoped name '${name}' must contain exactly one '/'`
      );
    }
    const scope = name.slice(1, slash);
    local = name.slice(slash + 1);
    if (!NPM_NAME_SEGMENT.test(scope)) {
      throw new Error(`Invalid npm package name: scope '@${scope}' is not a legal npm scope`);
    }
  } else {
    if (name.includes('/')) {
      throw new Error(
        `Invalid npm package name: '${name}' contains '/' but is not scoped (must start with '@')`
      );
    }
    local = name;
  }
  if (!NPM_NAME_SEGMENT.test(local)) {
    throw new Error(`Invalid npm package name: '${name}' is not a legal npm name`);
  }
  if (encodeURIComponent(local) !== local) {
    throw new Error(
      `Invalid npm package name: '${name}' contains characters that must be URL-encoded`
    );
  }
}

export function registryUrl(pkg: string, sub?: string): URL {
  validateNpmPackageName(pkg);
  const subPart = sub ? (sub.startsWith('/') ? sub : `/${sub}`) : '';
  const url = buildCdnUrl(REGISTRY_NPMJS_HOST, `/${pkg}${subPart}`);
  if (url.host !== REGISTRY_NPMJS_HOST) {
    throw new Error(
      `registryUrl: refused to build URL with host '${url.host}' (expected '${REGISTRY_NPMJS_HOST}')`
    );
  }
  return url;
}

export function jsdelivrNpmUrl(pkg: string, version?: string, file?: string): URL {
  const versionPart = version ? `@${version}` : '';
  const filePart = file ? `/${file.replace(/^\/+/, '')}` : '';
  return buildCdnUrl(JSDELIVR_HOST, `/npm/${pkg}${versionPart}${filePart}`);
}
