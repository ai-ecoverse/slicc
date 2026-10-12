export async function warmWterm(): Promise<void> {
  const { GhosttyCore } = await import('@wterm/ghostty');
  const core = await GhosttyCore.load({
    foregroundColor: '#e8e8ed',
    backgroundColor: '#0c0c0e',
  });
  core.dispose();
}
