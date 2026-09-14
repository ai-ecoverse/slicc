const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export function synthesizeForwardResponse(proxyResponse: Response): Response {
  const body = NULL_BODY_STATUSES.has(proxyResponse.status) ? null : proxyResponse.body;
  return new Response(body, {
    status: proxyResponse.status,
    statusText: proxyResponse.statusText,
    headers: proxyResponse.headers,
  });
}
