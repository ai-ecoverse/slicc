/** Build the lick WebSocket endpoint for an application URL. */
export function getLickWebSocketUrl(locationHref: string): string {
  const url = new URL(locationHref);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/licks-ws`;
}

/** Build the local node-server webhook endpoint for an application URL. */
export function getWebhookUrl(locationHref: string, webhookId: string): string {
  const url = new URL(locationHref);
  return `${url.origin}/webhooks/${webhookId}`;
}

/** Construct a per-webhook URL under a tray webhook capability URL. */
export function getTrayWebhookUrl(trayWebhookUrl: string, webhookId: string): string {
  const normalizedBase = trayWebhookUrl.replace(/\/+$/, '');
  const normalizedWebhookId = webhookId.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedWebhookId}`;
}
