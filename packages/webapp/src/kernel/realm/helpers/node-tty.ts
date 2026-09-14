class ReadStream {}
class WriteStream {}

export const nodeTty = {
  isatty: (_fd: number): boolean => false,
  ReadStream,
  WriteStream,
};
