/**
 * Unified picker popup: dispatches to the right system chooser based on
 * `?kind=`. Posts the outcome back over `chrome.runtime` messaging as
 * `{ source: 'picker-popup', kind, requestId, ... }` so the page-side
 * launcher in `picker-popup.ts` can correlate.
 *
 * Directory kind also stashes the granted handle in the shared
 * `slicc-pending-mount` IndexedDB store (under `pendingMount:<requestId>`)
 * because `FileSystemDirectoryHandle` is not postMessage-able.
 */
const PENDING_MOUNT_DB = 'slicc-pending-mount';
const params = new URLSearchParams(location.search);
const kind = params.get('kind') || 'directory';
const requestId = params.get('requestId') || '';

let filters = [];
try {
  filters = JSON.parse(params.get('filters') || '[]');
  if (!Array.isArray(filters)) filters = [];
} catch (_e) {
  filters = [];
}

const KIND_TITLES = {
  directory: { title: 'slicc mount', label: 'Select directory', working: 'Storing...' },
  'usb-device': { title: 'slicc usb', label: 'Select USB device', working: 'Connecting...' },
  'serial-port': { title: 'slicc serial', label: 'Select serial port', working: 'Connecting...' },
  'hid-device': { title: 'slicc hid', label: 'Select HID device', working: 'Connecting...' },
};

function applyKindLabels() {
  const t = KIND_TITLES[kind] || KIND_TITLES.directory;
  try {
    document.title = t.title;
  } catch (_e) {
    /* ignore */
  }
  document.getElementById('pickBtn').textContent = t.label;
  document.getElementById('label').textContent = t.working;
}

function send(extra) {
  try {
    chrome.runtime.sendMessage(
      Object.assign({ source: 'picker-popup', kind, requestId }, extra),
      function () {
        if (chrome.runtime.lastError) {
          /* no receiver */
        }
      }
    );
  } catch (_e) {
    /* context invalidated */
  }
}

function openDb() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(PENDING_MOUNT_DB, 1);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error);
    };
  });
}

async function pickDirectory() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const idbKey = 'pendingMount:' + requestId;
    const db = await openDb();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, idbKey);
    await new Promise(function (resolve, reject) {
      tx.oncomplete = resolve;
      tx.onerror = function () {
        reject(tx.error);
      };
      tx.onabort = function () {
        reject(tx.error || new Error('Transaction aborted'));
      };
    });
    db.close();
    send({ handleInIdb: true, idbKey: idbKey, dirName: handle.name });
  } catch (err) {
    if (err && err.name === 'AbortError') send({ cancelled: true });
    else send({ error: err ? err.message || String(err) : 'Unknown error' });
  }
}

async function pickUsb() {
  if (!navigator.usb || typeof navigator.usb.requestDevice !== 'function') {
    throw new Error('WebUSB is not available');
  }
  const device = await navigator.usb.requestDevice({ filters: filters });
  send({
    granted: true,
    info: {
      vendorId: device.vendorId,
      productId: device.productId,
      serialNumber: device.serialNumber || undefined,
    },
  });
}

async function pickSerial() {
  if (!navigator.serial || typeof navigator.serial.requestPort !== 'function') {
    throw new Error('Web Serial is not available');
  }
  const port = await navigator.serial.requestPort(filters.length ? { filters: filters } : {});
  if (!port) {
    send({ cancelled: true });
    return;
  }
  const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
  send({
    granted: true,
    info: { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId },
  });
}

async function pickHid() {
  if (!navigator.hid || typeof navigator.hid.requestDevice !== 'function') {
    throw new Error('WebHID is not available');
  }
  const devices = await navigator.hid.requestDevice({ filters: filters });
  const device = Array.isArray(devices) ? devices[0] : devices;
  if (!device) {
    send({ cancelled: true });
    return;
  }
  send({ granted: true, info: { vendorId: device.vendorId, productId: device.productId } });
}

async function onClick() {
  document.getElementById('pickBtn').style.display = 'none';
  document.getElementById('label').style.display = '';
  try {
    if (kind === 'directory') await pickDirectory();
    else if (kind === 'usb-device') await pickUsb();
    else if (kind === 'serial-port') await pickSerial();
    else if (kind === 'hid-device') await pickHid();
    else send({ error: 'unknown picker kind: ' + kind });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'NotFoundError'))
      send({ cancelled: true });
    else send({ error: err ? err.message || String(err) : 'Unknown error' });
  }
  window.close();
}

applyKindLabels();
document.getElementById('pickBtn').addEventListener('click', onClick);
