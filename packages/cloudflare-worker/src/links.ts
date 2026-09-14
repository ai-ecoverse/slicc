const STANDARD_RELS_TEMPLATE = (origin: string): string[] => [
  `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
  `<${origin}/.well-known/api-catalog>; rel="service-desc"; type="application/linkset+json"`,
  `<https://github.com/ai-ecoverse/slicc>; rel="service-doc"`,
  `<${origin}/status>; rel="status"; type="application/json"`,
  `<${origin}/llms.txt>; rel="https://llmstxt.org/rel/llms-txt"; type="text/markdown"`,
  `<https://github.com/ai-ecoverse/slicc/blob/main/LICENSE>; rel="license"`,
  `<https://github.com/ai-ecoverse/slicc#readme>; rel="terms-of-service"`,
];

export function applySliccLinks(response: Response, request: Request): Response {
  if (response.status === 101) return response;
  if (response.status >= 300 && response.status < 400) return response;

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const headers = new Headers(response.headers);
  for (const value of STANDARD_RELS_TEMPLATE(origin)) {
    headers.append('Link', value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function successorVersionLink(joinUrl: string): string | null {
  try {
    return `<${new URL(joinUrl).href}>; rel="successor-version"`;
  } catch {
    return null;
  }
}

export function supersededLinkHeaders(joinUrl: string): Record<string, string> {
  const link = successorVersionLink(joinUrl);
  return link ? { Link: link } : {};
}

export function supersededLocation(joinUrl: string, requestUrl: URL): string | null {
  let target: URL;
  try {
    target = new URL(joinUrl);
  } catch {
    return null;
  }
  if (requestUrl.searchParams.get('json') === 'true') {
    target.searchParams.set('json', 'true');
  }
  return target.href;
}

export function prefersManualRedirect(requestUrl: URL): boolean {
  return requestUrl.searchParams.get('redirect') === 'manual';
}
