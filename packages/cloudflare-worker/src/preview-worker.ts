import { handlePreviewRequest, type PreviewEnv } from './preview-handler.js';

export default {
  fetch: (request: Request, env: PreviewEnv): Promise<Response> =>
    handlePreviewRequest(request, env),
};
