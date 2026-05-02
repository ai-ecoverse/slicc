import AsyncHTTPClient
import Foundation
import Hummingbird
import HTTPTypes
import NIOHTTP1

private let oauthResultStore = OAuthResultStore()
private let webhookTimestampFormatter = ISO8601DateFormatter()
private let corsAllowOriginHeader = HTTPField.Name("Access-Control-Allow-Origin")!
private let corsAllowMethodsHeader = HTTPField.Name("Access-Control-Allow-Methods")!
private let corsAllowHeadersHeader = HTTPField.Name("Access-Control-Allow-Headers")!
private let cacheControlHeader = HTTPField.Name("Cache-Control")!
private let targetURLHeader = HTTPField.Name("X-Target-URL")!
private let proxyErrorMarkerHeader = HTTPField.Name("X-Proxy-Error")!
private let contentTypeHeaderValue = "application/json; charset=utf-8"
private let htmlContentTypeHeaderValue = "text/html; charset=utf-8"
private let proxyHopByHopHeaders: Set<String> = [
    "host", "connection", "x-target-url", "content-length", "transfer-encoding",
    "x-proxy-cookie", "x-proxy-origin", "x-proxy-referer",
]
private let proxyBlockedResponseHeaders: Set<String> = [
    "transfer-encoding", "content-encoding", "www-authenticate",
    "set-cookie",
]
private let fetchProxyMethods: [HTTPRequest.Method] = [.get, .head, .post, .put, .patch, .delete, .options]

private actor OAuthResultStore {
    struct PendingResult: Codable, Sendable, Equatable {
        let redirectUrl: String
        let error: String?
    }

    private var pending: PendingResult?

    func store(_ result: PendingResult) {
        self.pending = result
    }

    func take() -> PendingResult? {
        defer { self.pending = nil }
        return self.pending
    }
}

func registerAPIRoutes(
    router: Router<some RequestContext>,
    lickSystem: LickSystem,
    config: ServerConfig,
    httpClient: HTTPClient,
    secretInjector: SecretInjector = SecretInjector(secrets: [])
) {
    router.get("/api/runtime-config") { _, _ in
        let envWorkerBaseUrl: String? = {
            guard let raw = ProcessInfo.processInfo.environment["WORKER_BASE_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty else { return nil }
            return raw
        }()
        let trayWorkerBaseUrl = config.leadWorkerBaseUrl
            ?? envWorkerBaseUrl
            ?? (config.dev ? nil : "https://www.sliccy.ai")
        return try jsonResponse(
            .object([
                "trayWorkerBaseUrl": jsonStringOrNull(trayWorkerBaseUrl),
                "trayJoinUrl": jsonStringOrNull(config.joinUrl),
            ])
        )
    }

    router.get("/api/tray-status") { _, _ in
        do {
            return try jsonResponse(await lickSystem.sendRequest(type: "tray_status", data: [:], timeout: 5))
        } catch {
            return try jsonErrorResponse(status: .serviceUnavailable, message: errorMessage(error, fallback: "Browser not connected"))
        }
    }

    router.get("/api/webhooks") { _, _ in
        do {
            return try jsonResponse(await lickSystem.sendRequest(type: "list_webhooks", data: [:], timeout: 5))
        } catch {
            return try jsonErrorResponse(status: .serviceUnavailable, message: errorMessage(error, fallback: "Browser not connected"))
        }
    }

    router.post("/api/webhooks") { request, context in
        do {
            let payload = try await decodeJSONObjectBody(from: request, context: context)
            return try jsonResponse(await lickSystem.sendRequest(type: "create_webhook", data: payload, timeout: 5))
        } catch {
            let message = errorMessage(error)
            let status: HTTPResponse.Status = message.contains("Invalid") ? .badRequest : .serviceUnavailable
            return try jsonErrorResponse(status: status, message: message)
        }
    }

    router.delete("/api/webhooks/:id") { _, context in
        let id = context.parameters.get("id") ?? ""
        do {
            let response = try await lickSystem.sendRequest(
                type: "delete_webhook",
                data: ["id": .string(id)],
                timeout: 5
            )
            if case .object(let object) = response, let error = object["error"]?.stringValue {
                return try jsonErrorResponse(status: .notFound, message: error)
            }
            return try jsonResponse(response)
        } catch {
            return try jsonErrorResponse(status: .serviceUnavailable, message: errorMessage(error, fallback: "Browser not connected"))
        }
    }

    router.on("/webhooks/:id", method: .options) { _, _ in
        Response(status: .noContent, headers: corsHeaders(methods: "POST, OPTIONS", headers: "Content-Type"))
    }

    router.post("/webhooks/:id") { request, context in
        let id = context.parameters.get("id") ?? ""
        let body = try await decodeWebhookBody(from: request)
        await lickSystem.broadcastEvent([
            "type": .string("webhook_event"),
            "webhookId": .string(id),
            "timestamp": .string(webhookTimestampFormatter.string(from: Date())),
            "headers": .object(jsonHeaders(from: request.headers)),
            "body": body,
        ])
        return try jsonResponse(
            .object(["ok": .bool(true), "received": .bool(true)]),
            headers: [corsAllowOriginHeader: "*"]
        )
    }

    router.get("/api/crontasks") { _, _ in
        do {
            return try jsonResponse(await lickSystem.sendRequest(type: "list_crontasks", data: [:], timeout: 5))
        } catch {
            return try jsonErrorResponse(status: .serviceUnavailable, message: errorMessage(error, fallback: "Browser not connected"))
        }
    }

    router.post("/api/crontasks") { request, context in
        do {
            let payload = try await decodeJSONObjectBody(from: request, context: context)
            return try jsonResponse(await lickSystem.sendRequest(type: "create_crontask", data: payload, timeout: 5))
        } catch {
            let message = errorMessage(error)
            let status: HTTPResponse.Status = message.contains("Invalid") || message.contains("required")
                ? .badRequest
                : .serviceUnavailable
            return try jsonErrorResponse(status: status, message: message)
        }
    }

    router.delete("/api/crontasks/:id") { _, context in
        let id = context.parameters.get("id") ?? ""
        do {
            let response = try await lickSystem.sendRequest(
                type: "delete_crontask",
                data: ["id": .string(id)],
                timeout: 5
            )
            if case .object(let object) = response, let error = object["error"]?.stringValue {
                return try jsonErrorResponse(status: .notFound, message: error)
            }
            return try jsonResponse(response)
        } catch {
            return try jsonErrorResponse(status: .serviceUnavailable, message: errorMessage(error, fallback: "Browser not connected"))
        }
    }

    router.get("/auth/callback") { _, _ in
        Response(
            status: .ok,
            headers: [HTTPField.Name.contentType: htmlContentTypeHeaderValue],
            body: .init(byteBuffer: ByteBuffer(string: oauthCallbackHTML))
        )
    }

    router.post("/api/oauth-result") { request, context in
        let payload = try await request.decode(as: OAuthRelayPayload.self, context: context)
        await oauthResultStore.store(.init(redirectUrl: payload.redirectUrl ?? "", error: payload.error))
        return try jsonResponse(.object(["ok": .bool(true)]))
    }

    router.get("/api/oauth-result") { _, _ in
        guard let result = await oauthResultStore.take() else {
            return Response(status: .noContent)
        }
        return try jsonResponse(
            .object([
                "redirectUrl": .string(result.redirectUrl),
                "error": jsonStringOrNull(result.error),
            ])
        )
    }

    // Secret management API — direct Keychain access (no browser needed)
    router.get("/api/secrets") { _, _ in
        let entries = SecretStore.list()
        let items: [LickSystem.JSONValue] = entries.map { entry in
            .object([
                "name": .string(entry.name),
                "domains": .array(entry.domains.map { .string($0) }),
            ])
        }
        return try jsonResponse(.array(items))
    }

    // Masked secrets endpoint — returns name + maskedValue + domains for shell env population.
    // The browser fetches this at shell init to populate env vars with masked values.
    // Real values are never exposed; only deterministic session-scoped masks.
    router.get("/api/secrets/masked") { _, _ in
        let entries = secretInjector.maskedEntries
        let items: [LickSystem.JSONValue] = entries.map { entry in
            .object([
                "name": .string(entry.name),
                "maskedValue": .string(entry.maskedValue),
                "domains": .array(entry.domains.map { .string($0) }),
            ])
        }
        return try jsonResponse(.array(items))
    }

    for method in fetchProxyMethods {
        router.on("/api/fetch-proxy", method: method) { request, _ in
            guard let targetURLValue = request.headers[targetURLHeader],
                  let targetURL = URL(string: targetURLValue) else {
                return try proxyErrorResponse(status: .badRequest, message: "Missing X-Target-URL header")
            }

            let targetHostname = targetURL.host ?? ""

            do {
                var rawBody = try await collectBody(from: request)

                // --- Secret injection: scan headers + body for masked values ---
                var injectedHeaders = request.headers
                for field in request.headers {
                    switch secretInjector.inject(text: field.value, hostname: targetHostname) {
                    case .success(let replaced):
                        if replaced != field.value {
                            injectedHeaders[field.name] = replaced
                        }
                    case .domainBlocked(let secretName, let hostname):
                        return try proxyErrorResponse(
                            status: .forbidden,
                            message: "Secret \(secretName) is not allowed for domain \(hostname)"
                        )
                    }
                }

                // Inject secrets into request body — uses injectBody which leaves
                // masked values as-is on domain mismatch (safe/meaningless) rather
                // than rejecting. Avoids false 403s from LLM conversation context.
                if rawBody.readableBytes > 0,
                   let bodyString = rawBody.getString(at: rawBody.readerIndex, length: rawBody.readableBytes) {
                    let replaced = secretInjector.injectBody(text: bodyString, hostname: targetHostname)
                    if replaced != bodyString {
                        rawBody = ByteBuffer(string: replaced)
                    }
                }

                let injectedRequest = Request(
                    head: .init(
                        method: request.method,
                        scheme: request.head.scheme,
                        authority: request.head.authority,
                        path: request.head.path,
                        headerFields: injectedHeaders
                    ),
                    body: request.body
                )

                let upstreamRequest = try makeProxyRequest(from: injectedRequest, targetURL: targetURL, rawBody: rawBody)
                // Stream the upstream response straight through to the client so
                // that LLM SSE completions reach the browser token-by-token instead
                // of arriving in one giant burst at the end. Per-chunk secret-scrub
                // runs on text responses; secrets that span a chunk boundary slip
                // through unscrubbed (best-effort, matches Node-server behavior).
                let upstreamResponse = try await httpClient.execute(upstreamRequest, timeout: .hours(1))
                return try makeStreamingProxyResponse(from: upstreamResponse, secretInjector: secretInjector)
            } catch {
                return try proxyErrorResponse(status: .badGateway, message: "Proxy fetch failed: \(errorMessage(error))")
            }
        }
    }
}

private struct OAuthRelayPayload: Decodable {
    let redirectUrl: String?
    let error: String?
}

private let oauthCallbackHTML = """
<!DOCTYPE html><html><body><script>
  var q = new URLSearchParams(location.search);
  var h = new URLSearchParams(location.hash.replace(/^#/, ''));
  var payload = {
    type: 'oauth-callback',
    redirectUrl: location.href,
    code: q.get('code'),
    state: q.get('state') || h.get('state'),
    error: q.get('error') || h.get('error'),
    access_token: h.get('access_token'),
    expires_in: h.get('expires_in'),
    token_type: h.get('token_type')
  };
  if (window.opener) {
    window.opener.postMessage(payload, '*');
  } else {
    fetch('/api/oauth-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(function(err) { console.error('[oauth-callback] Failed to relay result to server:', err); });
  }
  window.close();
</script><p>Completing login... you can close this window.</p></body></html>
"""

private func decodeJSONObjectBody<Context: RequestContext>(from request: Request, context: Context) async throws -> LickSystem.JSONObject {
    let body = try await collectBody(from: request)
    guard body.readableBytes > 0 else { return [:] }
    return try decodeJSON(from: body, as: LickSystem.JSONObject.self)
}

private func decodeWebhookBody(from request: Request) async throws -> LickSystem.JSONValue {
    let body = try await collectBody(from: request)
    guard body.readableBytes > 0 else { return .object([:]) }
    do {
        return try decodeJSON(from: body, as: LickSystem.JSONValue.self)
    } catch {
        return .object(["raw": .string(String(buffer: body))])
    }
}

private func collectBody(from request: Request) async throws -> ByteBuffer {
    try await request.body.collect(upTo: 50 * 1024 * 1024)
}

private func decodeJSON<T: Decodable>(from buffer: ByteBuffer, as type: T.Type) throws -> T {
    var body = buffer
    let data = body.readData(length: body.readableBytes) ?? Data()
    return try JSONDecoder().decode(T.self, from: data)
}

private func jsonStringOrNull(_ value: String?) -> LickSystem.JSONValue {
    value.map(LickSystem.JSONValue.string) ?? .null
}

private func jsonResponse(
    _ value: LickSystem.JSONValue,
    status: HTTPResponse.Status = .ok,
    headers: HTTPFields = [:]
) throws -> Response {
    let data = try JSONEncoder().encode(value)
    var responseHeaders = headers
    responseHeaders[.contentType] = contentTypeHeaderValue
    return Response(
        status: status,
        headers: responseHeaders,
        body: .init(byteBuffer: ByteBuffer(bytes: data))
    )
}

private func jsonErrorResponse(status: HTTPResponse.Status, message: String) throws -> Response {
    try jsonResponse(.object(["error": .string(message)]), status: status)
}

/// Same as `jsonErrorResponse` but tags the response with `X-Proxy-Error: 1`
/// so SecureFetch clients can distinguish proxy infrastructure failures from
/// upstream 4xx/5xx responses that should flow through unchanged.
private func proxyErrorResponse(status: HTTPResponse.Status, message: String) throws -> Response {
    try jsonResponse(
        .object(["error": .string(message)]),
        status: status,
        headers: [proxyErrorMarkerHeader: "1"]
    )
}

private func corsHeaders(methods: String, headers: String) -> HTTPFields {
    [
        corsAllowOriginHeader: "*",
        corsAllowMethodsHeader: methods,
        corsAllowHeadersHeader: headers,
    ]
}

private func errorMessage(_ error: Error, fallback: String? = nil) -> String {
    let message = (error as NSError).localizedDescription
    if !message.isEmpty, message != "The operation could not be completed." {
        return message
    }
    return fallback ?? String(describing: error)
}

private func jsonHeaders(from headers: HTTPFields) -> LickSystem.JSONObject {
    var result: LickSystem.JSONObject = [:]
    for field in headers {
        let key = field.name.canonicalName.lowercased()
        if let existing = result[key] {
            switch existing {
            case .string(let current):
                result[key] = .array([.string(current), .string(field.value)])
            case .array(var values):
                values.append(.string(field.value))
                result[key] = .array(values)
            default:
                result[key] = .string(field.value)
            }
        } else {
            result[key] = .string(field.value)
        }
    }
    return result
}

private func makeProxyRequest(from request: Request, targetURL: URL, rawBody: ByteBuffer) throws -> HTTPClientRequest {
    var headers = HTTPHeaders(request.headers)
    headers.remove(name: "accept-encoding")

    // Forbidden-header transport: restore X-Proxy-Cookie → Cookie
    if let proxyCookie = headers["x-proxy-cookie"].first {
        headers.add(name: "Cookie", value: proxyCookie)
    }

    // Helper to check if a URL string is localhost
    func isLocalhostOrigin(_ value: String) -> Bool {
        guard let url = URL(string: value) else { return false }
        let host = url.host ?? ""
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    // Forbidden-header transport: restore X-Proxy-Origin → Origin
    if let proxyOrigin = headers["X-Proxy-Origin"].first {
        headers.replaceOrAdd(name: "Origin", value: proxyOrigin)
    } else if let currentOrigin = headers["Origin"].first, isLocalhostOrigin(currentOrigin) {
        // Only strip browser's auto-added localhost origin, preserve legitimate origins
        headers.remove(name: "Origin")
    }
    headers.remove(name: "X-Proxy-Origin")

    // Forbidden-header transport: restore X-Proxy-Referer → Referer
    if let proxyReferer = headers["X-Proxy-Referer"].first {
        headers.replaceOrAdd(name: "Referer", value: proxyReferer)
    } else if let currentReferer = headers["Referer"].first, isLocalhostOrigin(currentReferer) {
        // Only strip browser's auto-added localhost referer, preserve legitimate referers
        headers.remove(name: "Referer")
    }
    headers.remove(name: "X-Proxy-Referer")

    // Forbidden-header transport: restore X-Proxy-Proxy-* → Proxy-*
    let proxyPrefixHeaders = headers.compactMap { field -> (String, String)? in
        let lower = field.name.lowercased()
        guard lower.hasPrefix("x-proxy-proxy-") else { return nil }
        let restored = String(field.name.dropFirst("x-proxy-".count))
        return (restored, field.value)
    }
    for (name, _) in proxyPrefixHeaders {
        headers.remove(name: "x-proxy-\(name)")
    }
    for (name, value) in proxyPrefixHeaders {
        headers.add(name: name, value: value)
    }

    for header in proxyHopByHopHeaders {
        headers.remove(name: header)
    }
    headers.add(name: "accept-encoding", value: "identity")

    var clientRequest = HTTPClientRequest(url: targetURL.absoluteString)
    clientRequest.method = HTTPMethod(request.method)
    clientRequest.headers = headers
    if rawBody.readableBytes > 0 && request.method != .get && request.method != .head {
        clientRequest.body = .bytes(rawBody)
    }
    return clientRequest
}

private func makeStreamingProxyResponse(
    from response: HTTPClientResponse,
    secretInjector: SecretInjector
) throws -> Response {
    // Forbidden-header transport: collect Set-Cookie headers and encode as X-Proxy-Set-Cookie
    let setCookies = response.headers[canonicalForm: "set-cookie"].map { String($0) }

    var headers = HTTPFields(response.headers)
    for header in proxyBlockedResponseHeaders {
        headers[HTTPField.Name(header)!] = nil
    }
    // Strip any upstream X-Proxy-* headers to prevent spoofing
    let xProxyNames = headers.compactMap { field -> HTTPField.Name? in
        field.name.canonicalName.lowercased().hasPrefix("x-proxy-") ? field.name : nil
    }
    for name in xProxyNames {
        headers[name] = nil
    }
    // Drop Content-Length so the response is chunk-encoded transparently —
    // we no longer know the final length up front since the body streams.
    headers[HTTPField.Name.contentLength] = nil

    if !setCookies.isEmpty,
       let jsonData = try? JSONSerialization.data(withJSONObject: setCookies),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        headers[HTTPField.Name("X-Proxy-Set-Cookie")!] = secretInjector.scrub(text: jsonString)
    }

    // Scrub real secret values from response headers (one-shot — header
    // values are always small so per-chunk semantics don't apply).
    if !secretInjector.isEmpty {
        var scrubbedHeaders = HTTPFields()
        for field in headers {
            let scrubbedValue = secretInjector.scrub(text: field.value)
            scrubbedHeaders.append(HTTPField(name: field.name, value: scrubbedValue))
        }
        headers = scrubbedHeaders
    }

    headers[cacheControlHeader] = "no-store, no-cache"

    let contentType = (headers[HTTPField.Name.contentType] ?? "").lowercased()
    let isText = contentType.hasPrefix("text/")
        || contentType.hasPrefix("application/json")
        || contentType.contains("charset=")
        || contentType.contains("event-stream")
    let shouldScrub = isText && !secretInjector.isEmpty
    let upstreamBody = response.body
    let scrubber = secretInjector

    // Per-chunk transform — secrets crossing a chunk boundary slip through
    // unscrubbed. Acceptable for LLM SSE responses (matches Node-server).
    // Use the writer-based ResponseBody so each chunk is written and flushed
    // immediately. The previous shape of this code awaited each
    // `writer.write` inside a for-try-await over upstreamBody, which is
    // identical to Hummingbird's own AsyncSequence-backed body but lets us
    // fold in scrub without an intermediate map operator.
    let body = ResponseBody(asyncSequence: ScrubbingAsyncStream(
        upstream: upstreamBody,
        shouldScrub: shouldScrub,
        scrubber: scrubber
    ))

    return Response(
        status: HTTPResponse.Status(code: Int(response.status.code), reasonPhrase: response.status.reasonPhrase),
        headers: headers,
        body: body
    )
}

/// AsyncSequence wrapper that scrubs each ByteBuffer chunk from the
/// upstream HTTPClientResponse.Body before forwarding it to the Hummingbird
/// response writer. Exists so `ResponseBody(asyncSequence:)` can be used —
/// that path is the documented fast-path for streamed responses and avoids
/// any buffering inside the writer-based `ResponseBody { writer in ... }`
/// initializer.
///
/// UTF-8 boundary handling: when `shouldScrub` is true, the iterator keeps
/// trailing bytes that belong to an incomplete codepoint and prepends them
/// to the next chunk. Without this, decoding a chunk that ended mid-multi-
/// byte sequence would either fail (returning nil) or — worse, in a naive
/// re-encode — corrupt the codepoint with U+FFFD. Real LLM SSE traffic
/// often emits CJK / emoji / accented Latin so this matters for any non-
/// ASCII model output.
private struct ScrubbingAsyncStream: AsyncSequence, Sendable {
    typealias Element = ByteBuffer
    let upstream: HTTPClientResponse.Body
    let shouldScrub: Bool
    let scrubber: SecretInjector

    struct AsyncIterator: AsyncIteratorProtocol {
        var inner: HTTPClientResponse.Body.AsyncIterator
        let shouldScrub: Bool
        let scrubber: SecretInjector
        var pendingTail: [UInt8] = []
        var didEmitTail = false

        mutating func next() async throws -> ByteBuffer? {
            guard shouldScrub else {
                // Fast path: no scrub work, just forward chunks.
                return try await inner.next()
            }

            while let chunk = try await inner.next() {
                // Combine any unfinished bytes from the previous chunk.
                var bytes = pendingTail
                bytes.append(contentsOf: chunk.readableBytesView)
                pendingTail.removeAll(keepingCapacity: true)

                // Find the byte index of the last complete UTF-8 codepoint
                // boundary. Anything past that boundary becomes pendingTail
                // and rolls forward to the next chunk.
                let cut = lastCompleteUTF8Boundary(bytes)
                if cut == 0 {
                    // The chunk doesn't even close out the previous tail.
                    // Buffer it and ask upstream for more.
                    pendingTail = bytes
                    continue
                }
                if cut < bytes.count {
                    pendingTail = Array(bytes[cut...])
                    bytes.removeLast(bytes.count - cut)
                }

                guard let str = String(bytes: bytes, encoding: .utf8) else {
                    // Should not happen — we only pass complete codepoints —
                    // but if it does, drop the scrub for this chunk rather
                    // than corrupt the bytes.
                    return ByteBuffer(bytes: bytes)
                }
                let scrubbed = scrubber.scrub(text: str)
                return ByteBuffer(string: scrubbed)
            }

            // Upstream EOF. Emit any remaining tail bytes verbatim — they
            // form an incomplete codepoint that we couldn't scrub
            // safely, but truncating them would corrupt the response too.
            if !didEmitTail, !pendingTail.isEmpty {
                didEmitTail = true
                let tail = pendingTail
                pendingTail.removeAll()
                return ByteBuffer(bytes: tail)
            }
            return nil
        }
    }

    func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(inner: upstream.makeAsyncIterator(), shouldScrub: shouldScrub, scrubber: scrubber)
    }
}

/// Return the largest prefix length `n` of `bytes` such that bytes[0..<n] is
/// a complete sequence of UTF-8 codepoints. Continuation bytes (10xxxxxx)
/// at the tail mean the prefix is incomplete; we walk back from the end
/// until we find a leading byte and verify the codepoint it starts has
/// all its continuation bytes present.
private func lastCompleteUTF8Boundary(_ bytes: [UInt8]) -> Int {
    if bytes.isEmpty { return 0 }
    var i = bytes.count
    // Walk back over up to 3 continuation bytes (UTF-8 codepoints are at most
    // 4 bytes long, so any incomplete trailing codepoint has 1-3 trailing
    // continuation bytes plus a leading byte).
    var continuations = 0
    while i > 0, (bytes[i - 1] & 0xC0) == 0x80, continuations < 3 {
        i -= 1
        continuations += 1
    }
    if i == 0 {
        // Entire buffer is continuation bytes (malformed) — emit all
        // bytes; the String() decoder will reject and we'll forward
        // verbatim.
        return bytes.count
    }
    let lead = bytes[i - 1]
    let needed: Int
    if lead & 0x80 == 0 { needed = 1 }            // 0xxxxxxx
    else if lead & 0xE0 == 0xC0 { needed = 2 }    // 110xxxxx
    else if lead & 0xF0 == 0xE0 { needed = 3 }    // 1110xxxx
    else if lead & 0xF8 == 0xF0 { needed = 4 }    // 11110xxx
    else { return bytes.count }                   // malformed — pass through
    let have = bytes.count - (i - 1)
    if have >= needed { return bytes.count }
    return i - 1
}

private extension HTTPMethod {
    init(_ method: HTTPRequest.Method) {
        switch method {
        case .connect: self = .CONNECT
        case .delete: self = .DELETE
        case .get: self = .GET
        case .head: self = .HEAD
        case .options: self = .OPTIONS
        case .patch: self = .PATCH
        case .post: self = .POST
        case .put: self = .PUT
        case .trace: self = .TRACE
        default: self = .RAW(value: method.rawValue)
        }
    }
}

private extension HTTPHeaders {
    init(_ headers: HTTPFields) {
        self.init()
        for field in headers {
            self.add(name: field.name.canonicalName, value: field.value)
        }
    }
}

private extension HTTPFields {
    init(_ headers: HTTPHeaders) {
        self.init()
        for field in headers {
            if let name = HTTPField.Name(field.name) {
                self.append(HTTPField(name: name, value: field.value))
            }
        }
    }
}