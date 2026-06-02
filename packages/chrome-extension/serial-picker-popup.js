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

async function pickPort() {
  document.getElementById('pickBtn').style.display = 'none';
  document.getElementById('label').style.display = '';
  try {
    if (!navigator.serial || typeof navigator.serial.requestPort !== 'function') {
      throw new Error('Web Serial is not available');
    }
    const port = await navigator.serial.requestPort(filters.length ? { filters: filters } : {});
    if (!port) {
      send({ source: 'serial-picker-popup', requestId: requestId, cancelled: true });
    } else {
      const info = typeof port.getInfo === 'function' ? port.getInfo() : {};
      send({
        source: 'serial-picker-popup',
        requestId: requestId,
        granted: true,
        info: {
          usbVendorId: info.usbVendorId,
          usbProductId: info.usbProductId,
        },
      });
    }
  } catch (err) {
    if (err && (err.name === 'NotFoundError' || err.name === 'AbortError')) {
      send({ source: 'serial-picker-popup', requestId: requestId, cancelled: true });
    } else {
      send({
        source: 'serial-picker-popup',
        requestId: requestId,
        error: err ? err.message || String(err) : 'Unknown error',
      });
    }
  }
  window.close();
}

document.getElementById('pickBtn').addEventListener('click', pickPort);
