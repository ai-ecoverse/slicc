export function getLickWebSocketUrl(locationHref: string): string {
  const url = new URL(locationHref);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/licks-ws`;
}

export function getWebhookUrl(locationHref: string, webhookId: string): string {
  const url = new URL(locationHref);
  return `${url.origin}/webhooks/${webhookId}`;
}

export function getTrayWebhookUrl(trayWebhookUrl: string, webhookId: string): string {
  const normalizedBase = trayWebhookUrl.replace(/\/+$/, '');
  const normalizedWebhookId = webhookId.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedWebhookId}`;
}
