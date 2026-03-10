/**
 * Push migration artifacts to GitHub via isomorphic-git.
 * Stages blocks/, styles/, scripts/, head.html, and drafts/ then commits and pushes.
 *
 * Usage (in slicc JavaScript tool or bash):
 *   git add blocks/ styles/ scripts/ head.html drafts/
 *   git commit -m "feat: migrate {page-path} from {source-domain}"
 *   git push origin {branch}
 *
 * This script is a reference — the cone can run these as bash commands directly.
 */
// This is intentionally a documentation-only script.
// Git operations in slicc use the bash tool with isomorphic-git commands.
// No JavaScript needed — the skill instructs the cone to run:
//   git add blocks/ styles/ scripts/ head.html drafts/
//   git commit -m "feat: migrate ..."
//   git push
