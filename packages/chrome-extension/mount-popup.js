const PENDING_MOUNT_DB = 'slicc-pending-mount';
const requestId = new URLSearchParams(location.search).get('requestId') || '';

function send(msg) {
  try {
    chrome.runtime.sendMessage(msg, function () {
      if (chrome.runtime.lastError) {
        /* no receiver */
      }
    });
  } catch (e) {
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
  document.getElementById('pickBtn').style.display = 'none';
  document.getElementById('label').style.display = '';
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    document.getElementById('label').textContent = 'Storing handle...';
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
    send({
      source: 'mount-popup',
      type: 'mount-result',
      requestId: requestId,
      handleInIdb: true,
      idbKey: idbKey,
      dirName: handle.name,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      send({
        source: 'mount-popup',
        type: 'mount-result',
        requestId: requestId,
        cancelled: true,
      });
    } else {
      send({
        source: 'mount-popup',
        type: 'mount-result',
        requestId: requestId,
        error: err ? err.message || String(err) : 'Unknown error',
      });
    }
  }
  window.close();
}

document.getElementById('pickBtn').addEventListener('click', pickDirectory);
