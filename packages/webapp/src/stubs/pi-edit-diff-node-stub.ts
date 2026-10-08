export const constants = { R_OK: 4 };

export function access(): never {
  throw new Error('fs.access is not available in the browser');
}

export function readFile(): never {
  throw new Error('fs.readFile is not available in the browser');
}

export function resolveToCwd(): never {
  throw new Error('resolveToCwd is not available in the browser');
}
