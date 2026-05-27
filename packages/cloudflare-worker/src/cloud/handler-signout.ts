import { extractBearer, AuthError } from './auth.js';
import { invalidate } from './auth-cache.js';
import { errorResponse, okResponse } from './error-envelope.js';

export async function handleSignOut(request: Request): Promise<Response> {
  let token: string;
  try {
    token = extractBearer(request);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(401, err.code, err.message);
    return errorResponse(401, 'INVALID_TOKEN', 'auth failed');
  }
  await invalidate(token);
  return okResponse();
}
