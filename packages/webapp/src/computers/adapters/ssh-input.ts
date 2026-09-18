/**
 * Remote input command lines for a probed SSH computer (cliclick / xdotool /
 * ydotool / idb). Adapter-only — the backend injects `SshExec` and never
 * imports the `ssh` shell command.
 */

import type { ComputerInputEvent, ComputerMouseButton } from '@slicc/shared-ts';
import {
  parseKeysym,
  toCliclickToken,
  toTouchAction,
  toXdotoolKey,
  toYdotoolKey,
} from '../keys.js';

export type SshInputTool = 'cliclick' | 'xdotool' | 'ydotool' | 'idb' | 'none';

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cliclickPoint(prefix: string, x: number, y: number): string {
  return `cliclick ${prefix}:${Math.round(x)},${Math.round(y)}`;
}

function cliclickButton(button: ComputerMouseButton): 'c' | 'mc' | 'rc' {
  if (button === 2) return 'mc';
  if (button === 3) return 'rc';
  return 'c';
}

function xdotoolButton(button: ComputerMouseButton): number {
  return button;
}

function ydotoolClick(button: ComputerMouseButton, phase: 'click' | 'down' | 'up'): string {
  const n = button === 2 ? 2 : button === 3 ? 1 : 0;
  if (phase === 'down') return `ydotool click ${hexByte(0x40 | n)}`;
  if (phase === 'up') return `ydotool click ${hexByte(0x80 | n)}`;
  return `ydotool click ${hexByte(0xc0 | n)}`;
}

function hexByte(n: number): string {
  return `0x${n.toString(16).toUpperCase()}`;
}

function scrollSteps(dx: number, dy: number): number {
  const mag = Math.max(Math.abs(dx), Math.abs(dy));
  return Math.min(20, Math.max(1, Math.round(mag / 40) || 1));
}

function cliclickCommands(event: ComputerInputEvent): string[] {
  switch (event.type) {
    case 'mousemove':
      return [cliclickPoint('m', event.x, event.y)];
    case 'click': {
      const x = event.x ?? 0;
      const y = event.y ?? 0;
      if (event.holdMs && event.holdMs > 0) {
        return [
          cliclickPoint('dd', x, y),
          `sleep ${(event.holdMs / 1000).toFixed(3)}`,
          cliclickPoint('du', x, y),
        ];
      }
      const prefix = event.count >= 2 && event.button === 1 ? 'dc' : cliclickButton(event.button);
      const cmd = cliclickPoint(prefix, x, y);
      return event.count > 2 ? Array.from({ length: event.count }, () => cmd) : [cmd];
    }
    case 'button':
      return [cliclickPoint(event.down ? 'dd' : 'du', event.x ?? 0, event.y ?? 0)];
    case 'drag':
      return [cliclickPoint('dd', event.x1, event.y1), cliclickPoint('du', event.x2, event.y2)];
    case 'key': {
      const parsed = parseKeysym(event.keysym);
      if (!parsed) return [];
      const phase = event.down === true ? 'down' : event.down === false ? 'up' : 'press';
      return [`cliclick ${toCliclickToken(parsed, phase)}`];
    }
    case 'text':
      return [`cliclick ${shQuote(`t:${event.text}`)}`];
    case 'wait':
      return [`sleep ${(Math.max(0, event.ms) / 1000).toFixed(3)}`];
    case 'scroll':
      return [];
    default: {
      const _never: never = event;
      void _never;
      return [];
    }
  }
}

function xdotoolMove(x: number, y: number): string {
  return `xdotool mousemove -- ${Math.round(x)} ${Math.round(y)}`;
}

function xdotoolPointer(event: ComputerInputEvent): string[] | null {
  switch (event.type) {
    case 'mousemove':
      return event.relative
        ? [`xdotool mousemove_relative -- ${Math.round(event.x)} ${Math.round(event.y)}`]
        : [xdotoolMove(event.x, event.y)];
    case 'click': {
      const count = Math.max(1, event.count);
      const hold = event.holdMs && event.holdMs > 0 ? ` --delay ${event.holdMs}` : '';
      return [
        xdotoolMove(event.x ?? 0, event.y ?? 0),
        `xdotool click --repeat ${count}${hold} ${xdotoolButton(event.button)}`,
      ];
    }
    case 'button': {
      const verb = event.down ? 'mousedown' : 'mouseup';
      return [
        xdotoolMove(event.x ?? 0, event.y ?? 0),
        `xdotool ${verb} ${xdotoolButton(event.button)}`,
      ];
    }
    case 'drag':
      return [
        xdotoolMove(event.x1, event.y1),
        'xdotool mousedown 1',
        xdotoolMove(event.x2, event.y2),
        'xdotool mouseup 1',
      ];
    case 'scroll': {
      const btn = event.dy < 0 ? 4 : event.dy > 0 ? 5 : event.dx < 0 ? 6 : 7;
      return [
        xdotoolMove(event.x ?? 0, event.y ?? 0),
        `xdotool click --repeat ${scrollSteps(event.dx, event.dy)} ${btn}`,
      ];
    }
    default:
      return null;
  }
}

function xdotoolCommands(event: ComputerInputEvent): string[] {
  const pointer = xdotoolPointer(event);
  if (pointer) return pointer;
  if (event.type === 'key') {
    const parsed = parseKeysym(event.keysym);
    if (!parsed) return [];
    const chord = toXdotoolKey(parsed);
    if (event.down === true) return [`xdotool keydown ${chord}`];
    if (event.down === false) return [`xdotool keyup ${chord}`];
    return [`xdotool key ${chord}`];
  }
  if (event.type === 'text') return [`xdotool type -- ${shQuote(event.text)}`];
  if (event.type === 'wait') return [`sleep ${(Math.max(0, event.ms) / 1000).toFixed(3)}`];
  return [];
}

function ydotoolCommands(event: ComputerInputEvent): string[] {
  switch (event.type) {
    case 'mousemove':
      return [`ydotool mousemove --absolute -- ${Math.round(event.x)} ${Math.round(event.y)}`];
    case 'click': {
      const x = Math.round(event.x ?? 0);
      const y = Math.round(event.y ?? 0);
      const count = Math.max(1, event.count);
      const click = ydotoolClick(event.button, 'click');
      return [
        `ydotool mousemove --absolute -- ${x} ${y}`,
        ...Array.from({ length: count }, () => click),
      ];
    }
    case 'button': {
      const x = Math.round(event.x ?? 0);
      const y = Math.round(event.y ?? 0);
      return [
        `ydotool mousemove --absolute -- ${x} ${y}`,
        ydotoolClick(event.button, event.down ? 'down' : 'up'),
      ];
    }
    case 'drag':
      return [
        `ydotool mousemove --absolute -- ${Math.round(event.x1)} ${Math.round(event.y1)}`,
        ydotoolClick(1, 'down'),
        `ydotool mousemove --absolute -- ${Math.round(event.x2)} ${Math.round(event.y2)}`,
        ydotoolClick(1, 'up'),
      ];
    case 'scroll':
      return [
        `ydotool mousemove --absolute -- ${Math.round(event.x ?? 0)} ${Math.round(event.y ?? 0)}`,
        `ydotool click --repeat ${scrollSteps(event.dx, event.dy)} ${event.dy < 0 ? hexByte(0xc3) : hexByte(0xc4)}`,
      ];
    case 'key': {
      const parsed = parseKeysym(event.keysym);
      if (!parsed) return [];
      const phase = event.down === true ? 'down' : event.down === false ? 'up' : 'press';
      const seq = toYdotoolKey(parsed, phase);
      return seq ? [`ydotool key ${seq}`] : [];
    }
    case 'text':
      return [`ydotool type -- ${shQuote(event.text)}`];
    case 'wait':
      return [`sleep ${(Math.max(0, event.ms) / 1000).toFixed(3)}`];
    default: {
      const _never: never = event;
      void _never;
      return [];
    }
  }
}

function idbCommands(event: ComputerInputEvent, udid: string): string[] {
  const u = `--udid ${shQuote(udid)}`;
  if (event.type === 'key') {
    const parsed = parseKeysym(event.keysym);
    if (parsed?.key === 'Home') return [`idb ui button HOME ${u}`];
    if (parsed && parsed.key.length === 1 && !parsed.modifiers.ctrl && !parsed.modifiers.meta) {
      return [`idb ui text ${shQuote(parsed.key)} ${u}`];
    }
    return [];
  }
  if (event.type === 'text') return [`idb ui text ${shQuote(event.text)} ${u}`];
  if (event.type === 'wait') return [`sleep ${(Math.max(0, event.ms) / 1000).toFixed(3)}`];
  const touch = toTouchAction(event);
  if (touch.kind === 'noop') return [];
  if (touch.kind === 'tap') {
    return [`idb ui tap ${Math.round(touch.x)} ${Math.round(touch.y)} ${u}`];
  }
  if (touch.kind === 'long-press') {
    return [
      `idb ui tap ${Math.round(touch.x)} ${Math.round(touch.y)} --duration ${touch.holdMs} ${u}`,
    ];
  }
  return [
    `idb ui swipe ${Math.round(touch.x1)} ${Math.round(touch.y1)} ${Math.round(touch.x2)} ${Math.round(touch.y2)} ${u}`,
  ];
}

export function sshInputCommands(
  event: ComputerInputEvent,
  tool: SshInputTool,
  sim?: string
): string[] {
  if (tool === 'none') return [];
  if (tool === 'cliclick') return cliclickCommands(event);
  if (tool === 'xdotool') return xdotoolCommands(event);
  if (tool === 'ydotool') return ydotoolCommands(event);
  if (tool === 'idb' && sim) return idbCommands(event, sim);
  return [];
}
