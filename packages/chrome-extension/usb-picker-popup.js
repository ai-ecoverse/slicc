const params = new URLSearchParams(location.search);
const requestId = params.get('requestId') || '';

let filters = [];
try {
  filters = JSON.parse(params.get('filters') || '[]');
  if (!Array.isArray(filters)) filters = [];
} catch (_e) {
  filters = [];
}

function send(msg) {
  try {
    chrome.runtime.sendMessage(msg, function () {
      if (chrome.runtime.lastError) {
        /* no receiver */
      }
    });
  } catch (_e) {
    /* context invalidated */
  }
}

async function pickDevice() {
  document.getElementById('pickBtn').style.display = 'none';
  document.getElementById('label').style.display = '';
  try {
    if (!navigator.usb || typeof navigator.usb.requestDevice !== 'function') {
      throw new Error('WebUSB is not available');
    }
    const device = await navigator.usb.requestDevice({ filters: filters });
    send({
      source: 'usb-picker-popup',
      requestId: requestId,
      granted: true,
      info: {
        vendorId: device.vendorId,
        productId: device.productId,
        serialNumber: device.serialNumber || undefined,
      },
    });
  } catch (err) {
    if (err && (err.name === 'NotFoundError' || err.name === 'AbortError')) {
      send({ source: 'usb-picker-popup', requestId: requestId, cancelled: true });
    } else {
      send({
        source: 'usb-picker-popup',
        requestId: requestId,
        error: err ? err.message || String(err) : 'Unknown error',
      });
    }
  }
  window.close();
}

document.getElementById('pickBtn').addEventListener('click', pickDevice);
