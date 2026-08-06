// Match a `<...>ui/<rest>` string-literal in any form a back-edge can take:
// static import/re-export, dynamic import, or require. `<...>` is one or more
// `../` segments, and whitespace may span lines.
const UI_IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:\.\.\/)+ui\/[^'"]+['"]/g;

// Scan strings and comments as alternatives so comment markers inside strings
// and quotes inside comments do not start the other construct.
const COMMENT_OR_STRING_RE =
  /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** Blank comments while preserving newlines and string contents. */
export function stripComments(source) {
  return source.replace(COMMENT_OR_STRING_RE, (match) =>
    match.startsWith('//') || match.startsWith('/*') ? match.replace(/[^\n]/g, ' ') : match
  );
}

/** Find all relative imports from ui/, returning 1-based lines and matches. */
export function findUiImports(source) {
  const hits = [];
  const stripped = stripComments(source);
  for (const match of stripped.matchAll(UI_IMPORT_RE)) {
    const line = stripped.slice(0, match.index).split('\n').length;
    hits.push({ line, match: match[0].replace(/\s+/g, ' ') });
  }
  return hits;
}
