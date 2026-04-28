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
 *    (`TOKEN=value`, `API_KEY=value`, etc.)
 * 2. Authorization Bearer header values
 * 3. Long random-looking strings: GitHub tokens (`ghp_...`), hex hashes (40+),
 *    JWTs, and long alphanumeric strings (40+ chars)
 */
export function maskSecrets(text: string): string {
  let result = text;

  // 1. Env-var-style assignments with secret-looking names
  //    e.g. TOKEN=abc123..., MY_API_KEY=xyz, SECRET: somevalue
  result = result.replace(
    /([A-Z_]*(TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER|API_KEY|ACCESS_TOKEN)[=:]\s*)([^\s"'`]{8,})/gi,
    '$1***'
  );

  // 2. Authorization: Bearer <value>
  result = result.replace(
    /(Authorization:\s*Bearer\s+)([^\s"'`]{8,})/gi,
    '$1***'
  );

  // 3. Long random-looking strings:
  //    - GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_ + 36 chars)
  //    - Hex hashes (40+ hex chars)
  //    - Base64-ish long strings (40+ alphanumeric with optional trailing =)
  result = result.replace(
    /\b(ghp_[A-Za-z0-9]{36}|gh[a-z]_[A-Za-z0-9]{36}|[a-f0-9]{40}|[A-Za-z0-9+/]{40,}={0,2})\b/g,
    '***'
  );

  return result;
}
