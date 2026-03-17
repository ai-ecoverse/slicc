# Persistent Terminal Shell in Offscreen Document

## Problem

The user's interactive terminal in the extension side panel loses all state when the panel is closed and reopened. The `WasmShell` instance lives in the side panel — closing it destroys cwd, env, command history, and scrollback. Meanwhile, the agent's shells (cone + scoops) live in the offscreen document and survive panel close.

## Solution

Move the user's terminal shell to the offscreen document. The side panel Terminal tab becomes a thin xterm.js renderer connected via chrome.runtime messages. The shell survives panel close/reopen.

## Architecture

### Message flow

- Keystrokes: panel → offscreen (user types)
- Output: offscreen → panel (shell writes)
- Reconnect: panel requests scrollback → offscreen sends 1000-line buffer → panel writes to xterm
- Resize: panel → offscreen (terminal dimensions change)

### Lifecycle

- First side panel open: offscreen creates the shell + ring buffer
- Panel close: renderer destroyed, shell + buffer live on
- Panel reopen: new renderer, request scrollback, resume I/O
- Extension restart: shell recreated fresh (same as scoop shells)

## Components

### 1. TerminalProxy (new, offscreen doc)

A fake `Terminal` object that WasmShell mounts on. Implements `write()`, `onData`, `onKey`, `rows`, `cols`. `write()` sends messages to the panel AND appends to a 1000-line ring buffer. Keystroke callbacks are triggered when messages arrive from the panel.

### 2. OffscreenBridge changes (offscreen doc)

Creates the user's WasmShell + TerminalProxy on startup. Handles terminal messages: keystrokes in, output/scrollback out.

### 3. OffscreenClient changes (side panel)

Sends keystroke messages, receives output messages. On reconnect, requests scrollback buffer and writes it to xterm.js before resuming live I/O.

### 4. TerminalPanel / main.ts changes (side panel)

Instead of creating a local WasmShell, creates a bare xterm.js terminal connected to the offscreen shell via OffscreenClient.

### 5. New message types (messages.ts)

`terminal-input`, `terminal-output`, `terminal-resize`, `terminal-scrollback-request`, `terminal-scrollback`.

## Out of scope

- Switching terminal per scoop (user's terminal is always their own)
- Persisting shell across extension restart
- CLI mode changes
- Scrollback persistence across extension restart

## Key design decision: keystroke latency

Arrow keys, history navigation, cursor movement — all handled by WasmShell in the offscreen doc. Every keystroke round-trips through chrome.runtime messages (~3ms). This is imperceptible (well under 16ms frame budget). WasmShell logic stays unchanged — it just mounts on a proxy terminal instead of a real xterm.js instance.
