import {
  AuthError,
  type AuthResult,
  extractBearer,
  type ValidateBearerEnv,
  validateBearer,
} from './auth.js';
import { getCached, setCached } from './auth-cache.js';
import { errorResponse } from './error-envelope.js';

export async function authenticateRequest(
  request: Request,
  env: ValidateBearerEnv
): Promise<AuthResult | Response> {
  let token: string;
  try {
    token = extractBearer(request);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(401, err.code, err.message);
    return errorResponse(401, 'INVALID_TOKEN', 'auth failed');
  }
  const cached = await getCached(token);
  if (cached) return cached;
  try {
    const result = await validateBearer(token, env);
    // Cap cache TTL at min(10min, tokenExp − now) per spec — never cache past
    // the token's own expiry.
    await setCached(token, result, result.tokenExp);
    return result;
  } catch (err) {
    if (err instanceof AuthError) {
      let status: number;
      if (err.code === 'NOT_ALLOWED') status = 403;
      else if (err.code === 'UPSTREAM_UNAVAILABLE') status = 503;
      else status = 401;
      return errorResponse(status, err.code, err.message);
    }
    return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
  }
}
