// Voice recognition popup for Chrome extension mode.
// Runs in a real browser window so getUserMedia and webkitSpeechRecognition work.

let recognition = null;
let shouldBeListening = false;

const dot = document.getElementById('dot');
const label = document.getElementById('label');
const hint = document.getElementById('hint');

function send(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) { /* no receiver */ }
    });
  } catch { /* context invalidated */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'voice-popup') return;
  if (msg.type === 'voice-ping') {
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'voice-stop') {
    stopAndClose();
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

startRecognition();

async function startRecognition() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) {
    showError('Not supported');
    send({ source: 'voice-popup', type: 'speech-error', error: 'not-supported', fatal: true });
    setTimeout(() => window.close(), 1200);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch (err) {
    showError('Mic denied');
    send({
      source: 'voice-popup', type: 'speech-error',
      error: (err && err.name === 'NotFoundError') ? 'audio-capture' : 'not-allowed',
      fatal: true,
    });
    setTimeout(() => window.close(), 1500);
    return;
  }

  shouldBeListening = true;
  recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = new URLSearchParams(location.search).get('lang') || 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (final) {
      send({ source: 'voice-popup', type: 'speech-result', text: final, isFinal: true });
    } else if (interim) {
      send({ source: 'voice-popup', type: 'speech-result', text: interim, isFinal: false });
    }
  };

  recognition.onerror = (event) => {
    const code = event.error;
    if (code === 'no-speech') {
      send({ source: 'voice-popup', type: 'speech-error', error: code, fatal: false });
      return;
    }
    if (code === 'aborted') return;
    showError(code);
    send({ source: 'voice-popup', type: 'speech-error', error: code, fatal: true });
    shouldBeListening = false;
    setTimeout(() => window.close(), 1200);
  };

  recognition.onend = () => {
    if (shouldBeListening) {
      setTimeout(() => {
        if (shouldBeListening && recognition) {
          try { recognition.start(); } catch { stopAndClose(); }
        }
      }, 100);
    } else {
      send({ source: 'voice-popup', type: 'speech-end' });
      window.close();
    }
  };

  try {
    recognition.start();
    dot.className = 'dot';
    label.textContent = 'Listening...';
    hint.textContent = 'Close window or click mic to stop';
    send({ source: 'voice-popup', type: 'speech-state', state: 'listening' });
  } catch {
    showError('Start failed');
    send({ source: 'voice-popup', type: 'speech-error', error: 'start-failed', fatal: true });
    setTimeout(() => window.close(), 1200);
  }
}

function showError(text) {
  dot.className = 'dot dot--error';
  label.textContent = text;
  hint.textContent = '';
}

function stopAndClose() {
  shouldBeListening = false;
  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }
  send({ source: 'voice-popup', type: 'speech-end' });
  window.close();
}

window.addEventListener('beforeunload', () => {
  shouldBeListening = false;
  if (recognition) { try { recognition.stop(); } catch {} }
  send({ source: 'voice-popup', type: 'speech-end' });
});
