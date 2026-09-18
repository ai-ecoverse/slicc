export interface UsbControlSetup {
  requestType: 'standard' | 'class' | 'vendor';
  recipient: 'device' | 'interface' | 'endpoint' | 'other';
  request: number;
  value: number;
  index: number;
}

export interface UsbDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

export interface UsbInTransferResult {
  data?: { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  status?: string;
}

export interface UsbOutTransferResult {
  bytesWritten: number;
  status?: string;
}

interface UsbLiveEndpoint {
  readonly endpointNumber: number;
  readonly direction: string;
  readonly type: string;
  readonly packetSize: number;
}

interface UsbLiveAlternate {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly interfaceName?: string;
  readonly endpoints: readonly UsbLiveEndpoint[];
}

interface UsbLiveInterface {
  readonly interfaceNumber: number;
  readonly claimed: boolean;
  readonly alternates: readonly UsbLiveAlternate[];
}

interface UsbLiveConfiguration {
  readonly configurationValue: number;
  readonly configurationName?: string;
  readonly interfaces: readonly UsbLiveInterface[];
}

export interface UsbEndpointDescriptor {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
  packetSize: number;
}

export interface UsbAlternateDescriptor {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  interfaceName?: string;
  endpoints: UsbEndpointDescriptor[];
}

export interface UsbInterfaceDescriptor {
  interfaceNumber: number;
  claimed: boolean;
  alternates: UsbAlternateDescriptor[];
}

export interface UsbConfigurationDescriptor {
  configurationValue: number;
  configurationName?: string;
  interfaces: UsbInterfaceDescriptor[];
}

export interface UsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly manufacturerName?: string;
  readonly serialNumber?: string;
  readonly opened: boolean;

  readonly configurations?: readonly UsbLiveConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  controlTransferIn(setup: UsbControlSetup, length: number): Promise<UsbInTransferResult>;
  controlTransferOut(setup: UsbControlSetup, data?: BufferSource): Promise<UsbOutTransferResult>;
  transferIn(endpointNumber: number, length: number): Promise<UsbInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<UsbOutTransferResult>;
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
  reset(): Promise<void>;
}

export interface UsbApi {
  getDevices(): Promise<UsbDevice[]>;
  requestDevice(options: { filters: UsbDeviceFilter[] }): Promise<UsbDevice>;
}

export interface UsbDeviceInfo {
  handle: string;
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  opened: boolean;

  configurations?: UsbConfigurationDescriptor[];
}

export function getNavigatorUsb(): UsbApi | null {
  const nav = (globalThis as { navigator?: { usb?: UsbApi } }).navigator;
  return nav?.usb ?? null;
}

function sameDevice(a: UsbDevice, b: UsbDevice): boolean {
  if (a === b) return true;
  return (
    a.vendorId === b.vendorId &&
    a.productId === b.productId &&
    (a.serialNumber ?? '') === (b.serialNumber ?? '') &&
    !!a.serialNumber
  );
}

export const DEFAULT_USB_OWNER = 'usb';

export const USB_OWNER_SHELL = 'shell';

export const USB_OWNER_REALM = 'realm';

export function usbSprinkleOwner(sprinkleName: string): string {
  return `sprinkle:${sprinkleName}`;
}

export function parseUsbSprinkleOwner(owner: string): string | undefined {
  return owner.startsWith('sprinkle:') ? owner.slice('sprinkle:'.length) : undefined;
}

export interface UsbClaimOptions {
  owner?: string;

  wait?: boolean;

  signal?: AbortSignal;
}

export interface UsbExclusiveOptions {
  owner?: string;

  force?: boolean;
}

export interface UsbInterfaceClaim {
  handle: string;
  interfaceNumber: number;
  owner: string;
}

export interface UsbClaimEvent {
  type: 'claim-lost' | 'disconnect';
  handle: string;

  interfaceNumber?: number;

  holder: string;

  displacedBy: string;
  reason: 'close' | 'reset';
}

export type UsbClaimEventListener = (event: UsbClaimEvent) => void;

export class UsbInterfaceClaimError extends Error {
  readonly handle: string;
  readonly holder: string;
  readonly op: string;
  readonly interfaceNumber?: number;

  constructor(args: {
    handle: string;
    holder: string;
    op: string;
    interfaceNumber?: number;
  }) {
    const { handle, holder, op, interfaceNumber } = args;
    const where =
      interfaceNumber === undefined ? `'${handle}'` : `'${handle}' interface ${interfaceNumber}`;
    const hint = op === 'claim' ? '' : ' (pass force to override)';
    super(`usb ${op} ${where} refused: held by ${holder}${hint}`);
    this.name = 'UsbInterfaceClaimError';
    this.handle = handle;
    this.holder = holder;
    this.op = op;
    if (interfaceNumber !== undefined) this.interfaceNumber = interfaceNumber;
  }
}

export class DeviceHandleRegistry {
  private byHandle = new Map<string, UsbDevice>();
  private counter = 0;

  register(device: UsbDevice): string {
    for (const [handle, existing] of this.byHandle) {
      if (sameDevice(existing, device)) {
        this.byHandle.set(handle, device);
        return handle;
      }
    }
    const handle = `usb${++this.counter}`;
    this.byHandle.set(handle, device);
    return handle;
  }

  get(handle: string): UsbDevice | undefined {
    return this.byHandle.get(handle);
  }

  remove(handle: string): boolean {
    return this.byHandle.delete(handle);
  }

  list(): Array<{ handle: string; device: UsbDevice }> {
    return [...this.byHandle].map(([handle, device]) => ({ handle, device }));
  }
}

let sharedRegistry: DeviceHandleRegistry | null = null;

export function getSharedUsbRegistry(): DeviceHandleRegistry {
  if (!sharedRegistry) sharedRegistry = new DeviceHandleRegistry();
  return sharedRegistry;
}

export const MAX_USB_TRANSFER_BYTES = 4 * 1024 * 1024;

const ENDPOINT_DIRECTIONS = new Set(['in', 'out']);
const ENDPOINT_TYPES = new Set(['bulk', 'interrupt', 'isochronous']);

function configurationsToDescriptors(
  configurations: readonly UsbLiveConfiguration[]
): UsbConfigurationDescriptor[] {
  return configurations.map((configuration) => ({
    configurationValue: configuration.configurationValue,
    ...(configuration.configurationName
      ? { configurationName: configuration.configurationName }
      : {}),
    interfaces: (configuration.interfaces ?? []).map((iface) => ({
      interfaceNumber: iface.interfaceNumber,
      claimed: !!iface.claimed,
      alternates: (iface.alternates ?? []).map((alternate) => ({
        alternateSetting: alternate.alternateSetting,
        interfaceClass: alternate.interfaceClass,
        interfaceSubclass: alternate.interfaceSubclass,
        interfaceProtocol: alternate.interfaceProtocol,
        ...(alternate.interfaceName ? { interfaceName: alternate.interfaceName } : {}),
        endpoints: (alternate.endpoints ?? [])
          .filter(
            (endpoint) =>
              ENDPOINT_DIRECTIONS.has(endpoint.direction) && ENDPOINT_TYPES.has(endpoint.type)
          )
          .map((endpoint) => ({
            endpointNumber: endpoint.endpointNumber,
            direction: endpoint.direction as 'in' | 'out',
            type: endpoint.type as 'bulk' | 'interrupt' | 'isochronous',
            packetSize: endpoint.packetSize,
          })),
      })),
    })),
  }));
}

export function deviceToInfo(handle: string, device: UsbDevice): UsbDeviceInfo {
  return {
    handle,
    vendorId: device.vendorId,
    productId: device.productId,
    ...(device.productName ? { productName: device.productName } : {}),
    ...(device.manufacturerName ? { manufacturerName: device.manufacturerName } : {}),
    ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
    opened: device.opened,
    ...(device.configurations
      ? { configurations: configurationsToDescriptors(device.configurations) }
      : {}),
  };
}
