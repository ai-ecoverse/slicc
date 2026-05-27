export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): Response {
  return Response.json({ error: code, message, ...(details ? { details } : {}) }, { status });
}

export function okResponse(payload: Record<string, unknown> = { ok: true }): Response {
  return Response.json(payload, { status: 200 });
}
