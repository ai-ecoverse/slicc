/**
 * Dedicated preview worker — serves `*.sliccy.dev` (staging) and
 * `*.sliccy.now` (prod) preview URLs. No static assets binding, so
 * Cloudflare's asset CDN can't intercept requests before the worker runs.
 *
 * References the TRAY_HUB Durable Object from the main `slicc-tray-hub`
 * worker via `script_name` in wrangler-preview.jsonc. The request logic is
 * shared with the hub's preview path in `preview-handler.ts`.
 */

import { handlePreviewRequest, type PreviewEnv } from './preview-handler.js';

export default {
  fetch: (request: Request, env: PreviewEnv): Promise<Response> =>
    handlePreviewRequest(request, env),
};
