export const DEV_NULL = '/dev/null';

const DEV_FD_PATH = /^\/dev\/fd\/(0|[1-9][0-9]*)$/;

export function isEphemeralFdPath(path: string): boolean {
  return DEV_FD_PATH.test(path);
}

export const NO_OP_WRITE_DEVICE_PATHS = [DEV_NULL] as const;

export const NO_OP_WRITE_DEVICE_PATH_SET: ReadonlySet<string> = new Set(NO_OP_WRITE_DEVICE_PATHS);

export function isNoOpWriteDevicePath(path: string): boolean {
  return NO_OP_WRITE_DEVICE_PATH_SET.has(path);
}
