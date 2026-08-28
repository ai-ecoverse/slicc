// IIFE entry for the CDP virtual-network overlay loader — the artifact
// node-server / swift-server inject into the `srcdoc` frame of an Electron app
// that blocks all renderer network egress (e.g. Signal).
//
// Deliberately three lines: everything it does lives in `tunnel-runtime.ts`,
// which takes its browser globals as an argument so the whole boot is testable
// against a disposable frame. Mirrors `overlay-entry.ts` → `inject.ts`.

import { boot } from './tunnel-runtime.js';

void boot();
