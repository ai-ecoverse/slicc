import { authenticateRequest } from './auth-middleware.js';
import { errorResponse, okResponse } from './error-envelope.js';
import type { ValidateBearerEnv } from './auth.js';

export interface AdminEnv extends ValidateBearerEnv {
  ADMIN_USER_IDS: string;
}

export async function handleAdminStats(request: Request, env: AdminEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;

  const admins = (env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!admins.includes(auth.userId)) {
    return errorResponse(403, 'NOT_ADMIN', 'admin access required');
  }

  return okResponse({
    note: 'v1: aggregate stats limited; full team view via e2b dashboard',
  });
}
