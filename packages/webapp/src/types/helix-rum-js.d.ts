declare module '@adobe/helix-rum-js' {
  export function sampleRUM(checkpoint: string, data?: { source?: string; target?: string }): void;
}
