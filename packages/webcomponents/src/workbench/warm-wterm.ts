/**
 * Best-effort Ghostty WASM warm-up for `@wterm` 0.5.1+.
 *
 * The first `GhosttyCore.load` compiles WASM on the main thread and can block
 * for several seconds. Doing that during the first `<slicc-terminal>` mount
 * races tray heartbeats in two-leader e2e (`slicc-sidecar.test.ts`); evidence
 * and Renovate hold history: PR #3876. Compiling once after boot (then
 * disposing the throwaway core) lets later mounts reuse the compiled module.
 */
export async function warmWterm(): Promise<void> {
  const { GhosttyCore } = await import('@wterm/ghostty');
  const core = await GhosttyCore.load({
    foregroundColor: '#e8e8ed',
    backgroundColor: '#0c0c0e',
  });
  core.dispose();
}
