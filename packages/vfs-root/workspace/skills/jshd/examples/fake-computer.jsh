#!/usr/bin/env jsh
/**
 * Durable jsh-hosted computer with a push frame stream. `register()`
 * subscribes to host `computer-call` events, which keeps this unit
 * alive the same way `sliccy:hid` inputreport listeners do.
 * `handlers.subscribe` is the `computer watch` path; `screenshot`
 * still works as a poll fallback.
 *
 *   jshd start -n fake-computer --enable --restart always \
 *     /workspace/skills/jshd/examples/fake-computer.jsh
 *   computer ls
 *   computer screenshot -c jsh:fake
 *   computer watch -c jsh:fake
 *   computer click 1 --at 0,0 -c jsh:fake
 *   computer type -c jsh:fake hello
 */
const computer = require('sliccy:computer');

const JPEG = Uint8Array.of(
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9
);

let seq = 0;
let last = '';

function nextFrame() {
  seq += 1;
  return { seq, mime: 'image/jpeg', width: 1, height: 1, bytes: JPEG };
}

computer.register({
  id: 'jsh:fake',
  title: 'fake',
  size: { width: 1, height: 1 },
  capabilities: {
    screenshot: true,
    text: true,
    frames: 'push',
    keyboard: true,
    mouse: 'absolute',
    scroll: false,
    exec: false,
    inputAllowed: true,
  },
  async screenshot() {
    return nextFrame();
  },
  subscribe(fps, onFrame) {
    onFrame(nextFrame());
    const ms = Math.max(50, Math.round(1000 / Math.max(1, fps)));
    const timer = setInterval(() => onFrame(nextFrame()), ms);
    return () => clearInterval(timer);
  },
  async text() {
    return last || '(empty)';
  },
  async input(events) {
    for (const event of events) {
      if (event.type === 'text') last += event.text;
      if (event.type === 'key') last += `[${event.keysym}]`;
      if (event.type === 'click') last += `[click ${event.x},${event.y}]`;
    }
  },
});
