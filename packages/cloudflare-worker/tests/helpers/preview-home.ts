import type { DurableObjectNamespaceLike } from '../../src/shared.js';

/** Preview fixtures isolate routing; home lifecycle is exercised separately. */
export const previewHomeBindings: DurableObjectNamespaceLike = {
  idFromName: (name: string) => ({ toString: () => name }),
  get: () => ({
    fetch: async (request: Request) =>
      new URL(request.url).pathname === '/internal/home/bind' && request.method === 'POST'
        ? new Response(JSON.stringify({ bound: true }), { status: 200 })
        : new Response('Home route not stubbed', { status: 501 }),
  }),
};
