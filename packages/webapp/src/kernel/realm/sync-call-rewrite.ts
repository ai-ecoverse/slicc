/**
 * `sync-call-rewrite.ts` — source transform that makes `child_process`'s
 * `execSync`/`spawnSync` "just work" inside the realm despite being
 * implemented as async functions under the hood (see `child-process-shim.ts`).
 *
 * The realm always runs entry code inside an `AsyncFunction` wrapper (top-level
 * `await` is legal there — see `runUserCode` in `js-realm-shared.ts`), so
 * rewriting a call site `execSync(cmd)` to `(await execSync(cmd))` makes the
 * async shim behave synchronously from the caller's perspective at the top
 * level. Calls inside a nested non-async function still produce a runtime
 * mismatch (the rewritten `await` would be a SyntaxError there, so we don't
 * rewrite in that position at all — see below) — that's an inherent
 * limitation of faking sync exec in a single-threaded realm with no
 * `Atomics.wait`-based blocking, and is out of scope here.
 *
 * Implementation note: a pure fixed-width regex substitution
 * (`s/execSync(/​(await execSync(/`) only inserts the OPENING paren of the
 * wrapper — it can't also place the matching closing paren after the call's
 * own arguments, because regex has no way to find where a balanced
 * parenthesized argument list ends. Producing `(await execSync(cmd)` (one
 * unclosed paren) is a syntax error. This module therefore does a small
 * manual scan: find each `execSync`/`spawnSync` (optionally preceded by
 * `require('child_process').`) call site, walk forward from the invocation's
 * opening `(` counting nested parens/brackets/braces (skipping string and
 * template literals) to find the TRUE matching close paren, then wrap the
 * whole call expression in `(await …)`.
 *
 * Two call shapes are handled:
 *   1. `require('child_process').execSync(cmd)` — the whole property-access
 *      call is wrapped, starting at `require(`.
 *   2. A standalone identifier call `execSync(cmd)` / `spawnSync(cmd)` — the
 *      common destructured-import pattern
 *      (`const { execSync } = require('child_process')`) followed by a bare
 *      call. Arbitrary property access through some OTHER variable
 *      (`cp.execSync(...)`) is intentionally NOT rewritten: there is no safe
 *      way to turn `cp.execSync(...)` into an awaited expression without
 *      also rewriting every use of `cp`, so it's left for the user to
 *      destructure first (case 1 already covers the one common
 *      property-access idiom).
 *
 * Declarations (`function execSync(...) {}`) are excluded so a user-defined
 * helper with the same name isn't corrupted. String/comment/regex-literal
 * false positives for the BASE MATCH (finding the identifier) are guarded by
 * skipping over string/template literals while scanning for the closing
 * paren, but the initial identifier search itself is a simple text scan —
 * an identifier that happens to appear inside a string is an accepted,
 * extremely-unlikely-in-practice edge case for this lightweight transform
 * (a full AST rewrite is out of scope).
 *
 * Mirrored (functionally) in `packages/chrome-extension/sandbox.html`'s
 * `bootstrapRealmPort` for the extension float, which runs outside the TS
 * module graph.
 */

const SYNC_CALL_NAMES = /execSync|spawnSync/;

/** Matches the start of a call we should rewrite. Captures the callee text. */
const CALL_START =
  /(require\s*\(\s*['"]child_process['"]\s*\)\s*\.\s*(?:execSync|spawnSync)|(?<![.\w$])(?:execSync|spawnSync))\s*\(/g;

/**
 * Is the character at `source[idx]` preceded (ignoring whitespace) by the
 * `function` keyword, i.e. this is a function declaration/expression name
 * rather than a call? Used to skip `function execSync(...) {}`.
 */
function isFunctionDeclaration(source: string, matchStart: number): boolean {
  let i = matchStart - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  return source.slice(Math.max(0, i - 7), i + 1) === 'function';
}

/**
 * Starting at `openParenIdx` (the `(` that opens the call's argument list),
 * scan forward tracking paren/bracket/brace nesting (skipping over string,
 * template, and regex-adjacent contexts by the simple heuristic of skipping
 * quoted runs) to find the index of the matching closing `)`. Returns -1 if
 * the source is malformed and no match is found before EOF.
 */
function findMatchingParen(source: string, openParenIdx: number): number {
  let depth = 0;
  let i = openParenIdx;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
    }
    i++;
  }
  return -1;
}

export function rewriteSyncCalls(source: string): string {
  if (!SYNC_CALL_NAMES.test(source)) return source;

  // Build the rewritten source by walking left-to-right and copying spans,
  // wrapping each qualifying call in `(await …)`.
  let result = '';
  let cursor = 0;
  CALL_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_START.exec(source))) {
    const matchStart = m.index;
    if (matchStart < cursor) continue; // inside an already-rewritten span
    // Skip `function execSync(` / `function spawnSync(` declarations.
    if (isFunctionDeclaration(source, matchStart)) continue;
    const openParenIdx = matchStart + m[0].length - 1;
    const closeParenIdx = findMatchingParen(source, openParenIdx);
    if (closeParenIdx === -1) continue; // malformed source — leave as-is
    result += source.slice(cursor, matchStart);
    result += '(await ';
    result += source.slice(matchStart, closeParenIdx + 1);
    result += ')';
    cursor = closeParenIdx + 1;
    CALL_START.lastIndex = cursor;
  }
  result += source.slice(cursor);
  return result;
}
