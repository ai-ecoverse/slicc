/**
 * Pure, platform-agnostic helper that unmasks whole-token secret fields inside a
 * parsed CDP command frame, gating on the target tab's hostname via the existing
 * `SecretsPipeline` (no second masking implementation).
 *
 * Three CDP methods carry a single, whole masked token in one frame and are
 * the only ones unmasked here (D1 in the feature spec):
 *   - `Runtime.callFunctionOn` → string entries in `params.arguments[].value`
 *   - `Runtime.evaluate`       → `params.expression`
 *   - `Input.insertText`       → `params.text`
 *
 * Per-frame domain gating reuses `SecretsPipeline.unmaskBody` semantics:
 * on a domain mismatch (or missing secret) the value is left verbatim (no
 * forbidden surface — masked values in conversation context are harmless).
 *
 * Returns `{ frame, changed }`. When nothing applies the original frame
 * reference is returned untouched (no clone, no mutation).
 */

import type { SecretsPipeline } from './secrets-pipeline.js';

export interface CdpFrame {
  method?: string;
  params?: unknown;
  [key: string]: unknown;
}

export interface UnmaskCdpFrameResult {
  frame: CdpFrame;
  changed: boolean;
}

function unmaskString(
  pipeline: SecretsPipeline,
  hostname: string,
  value: string
): { text: string; changed: boolean } {
  const { text } = pipeline.unmaskBody(value, hostname);
  return { text, changed: text !== value };
}

export function unmaskCdpFrame(
  frame: CdpFrame,
  hostname: string,
  pipeline: SecretsPipeline
): UnmaskCdpFrameResult {
  if (!frame || typeof frame !== 'object') return { frame, changed: false };
  if (!pipeline.hasSecrets()) return { frame, changed: false };

  const method = frame.method;
  const params = frame.params;
  if (!params || typeof params !== 'object') return { frame, changed: false };

  if (method === 'Runtime.evaluate') {
    const p = params as { expression?: unknown };
    if (typeof p.expression !== 'string') return { frame, changed: false };
    const { text, changed } = unmaskString(pipeline, hostname, p.expression);
    if (!changed) return { frame, changed: false };
    return {
      frame: { ...frame, params: { ...p, expression: text } },
      changed: true,
    };
  }

  if (method === 'Input.insertText') {
    const p = params as { text?: unknown };
    if (typeof p.text !== 'string') return { frame, changed: false };
    const { text, changed } = unmaskString(pipeline, hostname, p.text);
    if (!changed) return { frame, changed: false };
    return {
      frame: { ...frame, params: { ...p, text } },
      changed: true,
    };
  }

  if (method === 'Runtime.callFunctionOn') {
    const p = params as { arguments?: unknown };
    if (!Array.isArray(p.arguments)) return { frame, changed: false };
    let argsChanged = false;
    const nextArgs = p.arguments.map((arg) => {
      if (!arg || typeof arg !== 'object') return arg;
      const a = arg as { value?: unknown };
      if (typeof a.value !== 'string') return arg;
      const { text, changed } = unmaskString(pipeline, hostname, a.value);
      if (!changed) return arg;
      argsChanged = true;
      return { ...a, value: text };
    });
    if (!argsChanged) return { frame, changed: false };
    return {
      frame: { ...frame, params: { ...p, arguments: nextArgs } },
      changed: true,
    };
  }

  return { frame, changed: false };
}
