/**
 * Pattern-based secret masking for collapsed tool-call previews.
 *
 * This module redacts sensitive-looking values (tokens, keys, passwords,
 * bearer headers, long random strings) from the short summary text shown
 * when a tool call is collapsed. The full unmasked content remains visible
 * when the user expands the tool call.
 *
 * Unlike the HMAC-based masking in `core/secret-masking.ts` (which produces
 * deterministic format-preserving replacements for proxy scrubbing), this is
 * a simple regex-based redaction that replaces matches with `***`.
 */

/**
 * Mask secret-looking values in a tool-call preview string.
 *
 * Patterns matched:
 * 1. Environment variable assignments with secret-looking names
 *    (`TOKEN=value`, `API_KEY=value`, etc.) — including single- and
 *    double-quoted values (`API_KEY="..."`, `API_KEY='...'`).
 * 2. Authorization Bearer header values.
 * 3. Long random-looking strings: GitHub tokens (`ghp_…`), hex hashes (40+
 *    chars, case-insensitive), and base64-ish alphanumeric strings (40+
 *    chars, with optional `=` padding).
 */
export function maskSecrets(text: string): string {
  let result = text;

  // 1a. Env-var-style assignments with double-quoted values
  //     e.g. TOKEN="abc123...", export API_KEY="sk-..."
  result = result.replace(
    /([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER|API_KEY|ACCESS_TOKEN)[=:]\s*)"([^"]{8,})"/gi,
    '$1"***"'
  );

  // 1b. Env-var-style assignments with single-quoted values
  //     e.g. TOKEN='abc123...'
  result = result.replace(
    /([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER|API_KEY|ACCESS_TOKEN)[=:]\s*)'([^']{8,})'/gi,
    "$1'***'"
  );

  // 1c. Env-var-style assignments with unquoted values
  //     e.g. TOKEN=abc123..., MY_API_KEY=xyz, SECRET: somevalue
  result = result.replace(
    /([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER|API_KEY|ACCESS_TOKEN)[=:]\s*)([^\s"'`]{8,})/gi,
    '$1***'
  );

  // 2. Authorization: Bearer <value>
  result = result.replace(/(Authorization:\s*Bearer\s+)([^\s"'`]{8,})/gi, '$1***');

  // 3. Long random-looking strings:
  //    - GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_ + 36 chars)
  //    - Hex hashes (40+ hex chars, case-insensitive)
  //    - Base64-ish long strings (40+ alphanumeric / +// with optional `=` padding)
  //    Use explicit non-token boundary lookarounds because `\b` does not
  //    handle trailing `=` padding correctly. The lookbehind excludes
  //    base64 token chars (but allows `=`, so values prefixed with `=` like
  //    `value=AAAA...` still trigger this fallback). The lookahead excludes
  //    the same set plus `=` to absorb optional trailing padding.
  result = result.replace(
    /(?<![A-Za-z0-9+/])(ghp_[A-Za-z0-9]{36}|gh[a-z]_[A-Za-z0-9]{36}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+/]{40,}={0,2})(?![A-Za-z0-9+/=])/g,
    '***'
  );

  return result;
}
