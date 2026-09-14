import { base64ToUint8, uint8ToBase64 } from '@slicc/shared-ts';

const BINARY_MARKER = '__slicc_binary__';
const BINARY_KIND_B64 = 'b64';

interface EncodedBinary {
  [BINARY_MARKER]: typeof BINARY_KIND_B64;
  data: string;
}

type TransportInput =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | TransportInput[]
  | TransportInputObject;

type TransportInputObject = { [key: string]: TransportInput };

type TransportWire =
  | null
  | boolean
  | number
  | string
  | EncodedBinary
  | TransportWire[]
  | TransportWireObject;

type TransportWireObject = { [key: string]: TransportWire };

function isEncodedBinary(value: unknown): value is EncodedBinary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as EncodedBinary;
  return candidate[BINARY_MARKER] === BINARY_KIND_B64 && typeof candidate.data === 'string';
}

function isTransportInputObject(value: unknown): value is TransportInputObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

function isTransportWireObject(value: unknown): value is TransportWireObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !isEncodedBinary(value)
  );
}

export function encodeBinaryForTransport(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    const encoded: EncodedBinary = { [BINARY_MARKER]: BINARY_KIND_B64, data: uint8ToBase64(value) };
    return encoded;
  }
  if (Array.isArray(value)) {
    return value.map(encodeBinaryForTransport) as TransportWire[];
  }
  if (isTransportInputObject(value)) {
    const out: TransportWireObject = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = encodeBinaryForTransport(v) as TransportWire;
    }
    return out;
  }
  return value as TransportWire;
}

export function decodeBinaryForTransport(value: unknown): unknown {
  if (isEncodedBinary(value)) return base64ToUint8(value.data);
  if (Array.isArray(value)) return value.map(decodeBinaryForTransport) as TransportInput[];
  if (isTransportWireObject(value)) {
    const out: TransportInputObject = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = decodeBinaryForTransport(v) as TransportInput;
    }
    return out;
  }
  return value as TransportInput;
}
