import { describe, expect, it } from 'vitest';
import { getLickWebSocketUrl, getTrayWebhookUrl, getWebhookUrl } from '../../src/base/lick-urls.js';

describe('lick URL builders', () => {
  it('builds lick websocket and webhook URLs from the current origin', () => {
    expect(getLickWebSocketUrl('http://localhost:5710/app')).toBe('ws://localhost:5710/licks-ws');
    expect(getLickWebSocketUrl('https://example.com/app')).toBe('wss://example.com/licks-ws');
    expect(getWebhookUrl('https://example.com/app?x=1', 'wh-123')).toBe(
      'https://example.com/webhooks/wh-123'
    );
  });

  it('constructs tray webhook URLs by appending the webhook ID', () => {
    expect(getTrayWebhookUrl('https://worker.example.com/webhook/tray-id.secret', 'wh123')).toBe(
      'https://worker.example.com/webhook/tray-id.secret/wh123'
    );
    expect(getTrayWebhookUrl('https://hub.slicc.dev/webhook/abc.def', 'my-webhook')).toBe(
      'https://hub.slicc.dev/webhook/abc.def/my-webhook'
    );
    expect(getTrayWebhookUrl('https://hub.slicc.dev/webhook/abc.def/', '/my-webhook')).toBe(
      'https://hub.slicc.dev/webhook/abc.def/my-webhook'
    );
  });
});
