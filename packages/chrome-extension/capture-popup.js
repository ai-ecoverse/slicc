// Media-capture popup for Chrome extension mode.
// Runs in a real browser window so getUserMedia / getDisplayMedia can show
// Chrome's permission prompt / screen picker. Reads the capture request from
// the URL, performs the capture, and posts the bytes (base64) back over
// chrome.runtime messaging.

const dot = document.getElementById('dot');
const label = document.getElementById('label');
const hint = document.getElementById('hint');
const action = document.getElementById('action');

const request = parseRequest();

let settled = false;

function parseRequest() {
  try {
    const raw = new URLSearchParams(location.search).get('req');
    if (!raw) return null;
    let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function send(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* context invalidated */
  }
}

function setStatus(text, isError) {
  label.textContent = text;
  if (isError) dot.className = 'dot dot--error';
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function describeMediaError(err) {
  if (err?.name) return `${err.name}: ${err.message || ''}`.trim();
  return err?.message ? err.message : String(err);
}

function fail(error) {
  settled = true;
  setStatus(error, true);
  hint.textContent = '';
  send({ source: 'capture-popup', requestId: request?.requestId, ok: false, error });
  setTimeout(() => window.close(), 1200);
}

function succeed(bytes, mimeType, width, height, durationMs) {
  settled = true;
  const msg = {
    source: 'capture-popup',
    requestId: request.requestId,
    ok: true,
    bytesBase64: bytesToBase64(bytes),
    mimeType,
    width,
    height,
  };
  if (typeof durationMs === 'number') msg.durationMs = durationMs;
  send(msg);
  setTimeout(() => window.close(), 200);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (
    msg &&
    msg.target === 'capture-popup' &&
    msg.type === 'capture-abort' &&
    (!request || msg.requestId === request.requestId)
  ) {
    window.close();
  }
  return false;
});

// If the user closes the popup (or it unloads) before the capture settles,
// post a single cancellation failure so the shell-side captureViaPopup
// rejects promptly instead of hanging until its ~5-minute timeout. The
// `settled` guard prevents a double-send after a normal succeed()/fail()
// (whose own window.close() calls also trigger pagehide).
window.addEventListener('pagehide', () => {
  if (settled) return;
  settled = true;
  send({
    source: 'capture-popup',
    requestId: request?.requestId,
    ok: false,
    error: 'capture cancelled',
  });
});

if (!request) {
  fail('invalid capture request');
} else if (request.kind === 'screen') {
  setupScreenButton();
} else {
  runCameraCapture();
}

// ---------- screen capture ----------

function setupScreenButton() {
  setStatus('Screen capture ready');
  hint.textContent = 'Click below, then choose a screen, window, or tab to capture.';
  action.style.display = 'inline-block';
  action.textContent = 'Capture screen';
  action.addEventListener('click', () => {
    action.disabled = true;
    runScreenCapture();
  });
}

async function runScreenCapture() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    fail(describeMediaError(err));
    return;
  }
  try {
    setStatus('Capturing…');
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = () => video.play().then(res).catch(rej);
      video.onerror = () => rej(new Error('Failed to load screen stream'));
    });
    await new Promise((r) => setTimeout(r, 100));
    const width = video.videoWidth;
    const height = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise((res, rej) =>
      canvas.toBlob(
        (b) => (b ? res(b) : rej(new Error('Failed to create image blob'))),
        request.mimeType,
        request.quality
      )
    );
    succeed(new Uint8Array(await blob.arrayBuffer()), request.mimeType, width, height);
  } catch (err) {
    fail(describeMediaError(err));
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

// ---------- camera / mic capture ----------

async function runCameraCapture() {
  const req = request;
  const wantVideo = req.mode === 'photo' || req.captureVideo !== false;
  const wantAudio = !!req.captureAudio && req.mode === 'video';
  if (!wantVideo && !wantAudio) {
    fail('camera capture: at least one of video or audio must be requested');
    return;
  }

  setStatus('Requesting permission…');
  hint.textContent = 'Allow camera/microphone access when prompted.';
  // Prime the permission so the prompt shows here (in a visible window) and
  // so enumerateDevices() returns real deviceIds for numeric-index lookups.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: wantVideo, audio: wantAudio });
    for (const t of probe.getTracks()) t.stop();
  } catch (err) {
    fail(describeMediaError(err));
    return;
  }

  const videoId = wantVideo ? await resolveDeviceId(req.deviceId, 'videoinput') : undefined;
  const audioId = wantAudio ? await resolveDeviceId(req.audioDeviceId, 'audioinput') : undefined;

  let stream;
  try {
    stream = await getStreamWithFallback({
      wantVideo,
      wantAudio,
      videoId,
      audioId,
      width: req.width,
      height: req.height,
      frameRate: req.frameRate,
      exact: !!req.exactSize,
    });
  } catch (err) {
    fail(describeMediaError(err));
    return;
  }

  try {
    setStatus(req.mode === 'photo' ? 'Capturing photo…' : 'Recording…');
    hint.textContent = '';
    if (req.mode === 'photo') {
      const r = await capturePhoto(stream, req);
      succeed(r.bytes, r.mimeType, r.width, r.height);
    } else {
      const r = await captureClip(stream, req, wantVideo);
      succeed(r.bytes, r.mimeType, r.width, r.height, r.durationMs);
    }
  } catch (err) {
    fail(describeMediaError(err));
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

async function resolveDeviceId(idOrIndex, kind) {
  if (!idOrIndex) return undefined;
  if (!/^\d+$/.test(idOrIndex)) return idOrIndex;
  if (!navigator.mediaDevices.enumerateDevices) return undefined;
  const all = await navigator.mediaDevices.enumerateDevices();
  const dev = all.filter((d) => d.kind === kind)[parseInt(idOrIndex, 10)];
  return dev ? dev.deviceId : undefined;
}

async function getStreamWithFallback(spec) {
  const buildVideo = (mode) => {
    if (!spec.wantVideo) return false;
    const c = {};
    if (spec.videoId) c.deviceId = { exact: spec.videoId };
    if (spec.width) c.width = mode === 'exact' ? { exact: spec.width } : { ideal: spec.width };
    if (spec.height) c.height = mode === 'exact' ? { exact: spec.height } : { ideal: spec.height };
    if (spec.frameRate)
      c.frameRate = mode === 'exact' ? { exact: spec.frameRate } : { ideal: spec.frameRate };
    return Object.keys(c).length > 0 ? c : true;
  };
  const audio = () => {
    if (!spec.wantAudio) return false;
    if (spec.audioId) return { deviceId: { exact: spec.audioId } };
    return true;
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: buildVideo(spec.exact ? 'exact' : 'ideal'),
      audio: audio(),
    });
  } catch (err) {
    if (!spec.exact || (err.name !== 'OverconstrainedError' && err.name !== 'NotReadableError')) {
      throw err;
    }
    return await navigator.mediaDevices.getUserMedia({
      video: buildVideo('ideal'),
      audio: audio(),
    });
  }
}

async function capturePhoto(stream, req) {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await new Promise((res, rej) => {
    video.onloadedmetadata = () => video.play().then(res).catch(rej);
    video.onerror = () => rej(new Error('Failed to load camera stream'));
  });
  await new Promise((r) => requestAnimationFrame(() => r()));
  await new Promise((r) => requestAnimationFrame(() => r()));
  const warmupMs = req.warmupMs != null ? req.warmupMs : 1500;
  if (warmupMs > 0) await new Promise((r) => setTimeout(r, warmupMs));
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(video, 0, 0, width, height);
  const blob = await new Promise((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error('Failed to encode photo'))),
      req.mimeType,
      req.quality
    )
  );
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width,
    height,
    mimeType: blob.type || req.mimeType,
  };
}

async function captureClip(stream, req, wantVideo) {
  let width = 0;
  let height = 0;
  if (wantVideo) {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = () => video.play().then(res).catch(rej);
      video.onerror = () => rej(new Error('Failed to load camera stream'));
    });
    await new Promise((r) => requestAnimationFrame(() => r()));
    width = video.videoWidth;
    height = video.videoHeight;
  }
  const durationMs = Math.max(100, Math.min(req.durationMs || 5000, 60000));
  const supported =
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(req.mimeType)
      ? req.mimeType
      : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType: supported });
  const chunks = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  const stopped = new Promise((res) => {
    recorder.onstop = () => res();
  });
  recorder.start();
  await new Promise((r) => setTimeout(r, durationMs));
  recorder.stop();
  await stopped;
  const blob = new Blob(chunks, { type: supported });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width,
    height,
    mimeType: blob.type || supported,
    durationMs,
  };
}
