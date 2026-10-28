#!/usr/bin/env bash
# Verify the developer-skill router and Claude skill aliases match the
# canonical skills in .agents/skills/.
#
# Usage: bash packages/dev-tools/tools/check-skill-router-sync.sh [repo-root]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
ROUTER="$REPO_ROOT/AGENTS.md"
AGENT_SKILLS="$REPO_ROOT/.agents/skills"
CLAUDE_SKILLS="$REPO_ROOT/.claude/skills"

if [[ ! -f "$ROUTER" ]]; then
  echo "::error::Developer-skill router not found at $ROUTER" >&2
  exit 2
fi
if [[ ! -d "$AGENT_SKILLS" ]]; then
  echo "::error::Canonical developer-skill directory not found at $AGENT_SKILLS" >&2
  exit 2
fi
if [[ ! -d "$CLAUDE_SKILLS" ]]; then
  echo "::error::Claude skill directory not found at $CLAUDE_SKILLS" >&2
  exit 2
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -r "$TEMP_DIR"' EXIT
ROUTER_SKILLS="$TEMP_DIR/router-skills"
ACTUAL_SKILLS="$TEMP_DIR/actual-skills"
MISSING_FROM_ROUTER="$TEMP_DIR/missing-from-router"
MISSING_FROM_DISK="$TEMP_DIR/missing-from-disk"

awk '
  /^## Developer Agent Skills \(\.agents\/skills\/\)$/ { in_section = 1; next }
  in_section && /^## / { exit }
  in_section && /→ use `/ {
    line = $0
    sub(/^.*→ use `/, "", line)
    sub(/`.*/, "", line)
    print line
  }
' "$ROUTER" | sort -u >"$ROUTER_SKILLS"

shopt -s nullglob
skill_files=("$AGENT_SKILLS"/*/SKILL.md)
for skill_file in ${skill_files[@]+"${skill_files[@]}"}; do
  basename "$(dirname "$skill_file")"
done | sort -u >"$ACTUAL_SKILLS"

if [[ ! -s "$ROUTER_SKILLS" ]]; then
  echo "::error::No developer skills found in the AGENTS.md router" >&2
  echo "Expected backtick-quoted skill names in lines containing '→ use'." >&2
  exit 1
fi
if [[ ! -s "$ACTUAL_SKILLS" ]]; then
  echo "::error::No canonical developer skills found in $AGENT_SKILLS" >&2
  exit 1
fi

comm -23 "$ACTUAL_SKILLS" "$ROUTER_SKILLS" >"$MISSING_FROM_ROUTER"
comm -13 "$ACTUAL_SKILLS" "$ROUTER_SKILLS" >"$MISSING_FROM_DISK"
STATUS=0

if [[ -s "$MISSING_FROM_ROUTER" ]]; then
  STATUS=1
  echo "::error::Developer skills missing from the AGENTS.md router" >&2
  sed 's/^/  - /' "$MISSING_FROM_ROUTER" >&2
fi
if [[ -s "$MISSING_FROM_DISK" ]]; then
  STATUS=1
  echo "::error::AGENTS.md router references nonexistent developer skills" >&2
  sed 's/^/  - /' "$MISSING_FROM_DISK" >&2
fi

for skill_file in ${skill_files[@]+"${skill_files[@]}"}; do
  name="$(basename "$(dirname "$skill_file")")"
  if [[ ! -e "$CLAUDE_SKILLS/$name" && ! -L "$CLAUDE_SKILLS/$name" ]]; then
    STATUS=1
    echo "::error::Canonical developer skill missing from .claude/skills: $name" >&2
  fi
done

claude_entries=("$CLAUDE_SKILLS"/*)
# ${arr[@]+"${arr[@]}"} guards an empty array under `set -u` on bash < 4.4 (the
# macOS release runner ships bash 3.2), where a bare "${arr[@]}" is a fatal
# "unbound variable" error. Without the guard, an empty .claude/skills aborts
# here — after STATUS=1 was set for a missing skill — before the final
# `exit 1`, and the EXIT trap's `rm` then reset the exit code to 0, so the
# check silently passed when it should have failed.
for entry in ${claude_entries[@]+"${claude_entries[@]}"}; do
  name="$(basename "$entry")"
  canonical="$AGENT_SKILLS/$name"
  if [[ ! -d "$canonical" || ! -f "$canonical/SKILL.md" ]]; then
    STATUS=1
    echo "::error::Claude skill has no canonical developer skill: $name" >&2
    continue
  fi

  if [[ -L "$entry" ]]; then
    if ! resolved="$(cd "$entry" 2>/dev/null && pwd -P)"; then
      STATUS=1
      echo "::error::Claude skill symlink is broken: $name" >&2
      continue
    fi
    expected="$(cd "$canonical" && pwd -P)"
    if [[ "$resolved" != "$expected" ]]; then
      STATUS=1
      echo "::error::Claude skill symlink must resolve to .agents/skills/$name" >&2
    fi
  elif [[ ! -d "$entry" ]] || ! diff -qr -- "$canonical" "$entry" >/dev/null; then
    STATUS=1
    echo "::error::Claude skill differs from canonical developer skill: $name" >&2
  fi
done

if [[ "$STATUS" -ne 0 ]]; then
  exit 1
fi

COUNT="$(wc -l <"$ACTUAL_SKILLS" | tr -d ' ')"
echo "✓ All $COUNT developer skill(s) match the AGENTS.md router and .claude/skills"
