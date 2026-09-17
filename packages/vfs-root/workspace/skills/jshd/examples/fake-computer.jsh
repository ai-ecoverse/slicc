#!/usr/bin/env jsh
/**
 * Durable jsh-hosted computer. `register()` subscribes to host
 * `computer-call` events, which keeps this unit alive the same way
 * `sliccy:hid` inputreport listeners do.
 *
 *   jshd start -n fake-computer --enable --restart always \
 *     /workspace/skills/jshd/examples/fake-computer.jsh
 *   computer ls
 *   computer screenshot -c jsh:fake
 *   computer type -c jsh:fake hello
 */
const computer = require('sliccy:computer');

const JPEG = Uint8Array.of(
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9
);

let seq = 0;
let last = '';

computer.register({
  id: 'jsh:fake',
  title: 'fake',
  size: { width: 1, height: 1 },
  capabilities: {
    screenshot: true,
    text: true,
    frames: 'poll',
    keyboard: true,
    mouse: 'none',
    scroll: false,
    exec: false,
    inputAllowed: true,
  },
  async screenshot() {
    seq += 1;
    return { seq, mime: 'image/jpeg', width: 1, height: 1, bytes: JPEG };
  },
  async text() {
    return last || '(empty)';
  },
  async input(events) {
    for (const event of events) {
      if (event.type === 'text') last += event.text;
      if (event.type === 'key') last += `[${event.keysym}]`;
    }
  },
});
