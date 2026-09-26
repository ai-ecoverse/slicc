declare module 'bzip2' {
  interface BitStream {
    index: number;
    buffer: number | Uint8Array | number[];
  }

  export function array(bytes: Uint8Array | ArrayLike<number>): BitStream;
  export function header(bits: BitStream): void;

  export function simple(bits: BitStream): number[];
  export function decompress(bits: BitStream, size: number): number[] | -1;
}
