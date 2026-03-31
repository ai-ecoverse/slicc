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

    router.post("/api/secrets") { request, context in
        let payload = try await decodeJSONObjectBody(from: request, context: context)
        guard let name = payload["name"]?.stringValue, !name.isEmpty else {
            return try jsonErrorResponse(status: .badRequest, message: "Missing required field: name")
        }
        guard let value = payload["value"]?.stringValue, !value.isEmpty else {
            return try jsonErrorResponse(status: .badRequest, message: "Missing required field: value")
        }
        let domains: [String]
        if case .array(let arr) = payload["domains"] {
            domains = arr.compactMap(\.stringValue)
        } else {
            domains = []
        }
        do {
            try SecretStore.set(name: name, value: value, domains: domains)
            secretInjector.reload()
            return try jsonResponse(.object(["ok": .bool(true), "name": .string(name)]))
        } catch SecretStoreError.emptyDomains {
            return try jsonErrorResponse(status: .badRequest, message: "Secret must have at least one authorized domain")
        } catch {
            return try jsonErrorResponse(status: .internalServerError, message: errorMessage(error))
        }
    }

    router.delete("/api/secrets/:name") { _, context in
        let name = context.parameters.get("name") ?? ""
        do {
            try SecretStore.delete(name: name)
            secretInjector.reload()
            return try jsonResponse(.object(["ok": .bool(true), "name": .string(name)]))
        } catch {
            return try jsonErrorResponse(status: .internalServerError, message: errorMessage(error))
        }
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
                return try jsonErrorResponse(status: .badRequest, message: "Missing X-Target-URL header")
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
                        return try jsonErrorResponse(
                            status: .forbidden,
                            message: "Secret \(secretName) is not allowed for domain \(hostname)"
                        )
                    }
                }

                // Inject secrets into request body
                if rawBody.readableBytes > 0,
                   let bodyString = rawBody.getString(at: rawBody.readerIndex, length: rawBody.readableBytes) {
                    switch secretInjector.inject(text: bodyString, hostname: targetHostname) {
                    case .success(let replaced):
                        if replaced != bodyString {
                            rawBody = ByteBuffer(string: replaced)
                        }
                    case .domainBlocked(let secretName, let hostname):
                        return try jsonErrorResponse(
                            status: .forbidden,
                            message: "Secret \(secretName) is not allowed for domain \(hostname)"
                        )
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
                let upstreamResponse = try await httpClient.execute(request: upstreamRequest).get()

                // --- Response scrubbing: replace real values with masked ---
                return makeProxyResponse(from: upstreamResponse, secretInjector: secretInjector)
            } catch {
                return try jsonErrorResponse(status: .badGateway, message: "Proxy fetch failed: \(errorMessage(error))")
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

private func makeProxyRequest(from request: Request, targetURL: URL, rawBody: ByteBuffer) throws -> HTTPClient.Request {
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

    let body: HTTPClient.Body? = if rawBody.readableBytes > 0 && request.method != .get && request.method != .head {
        .byteBuffer(rawBody)
    } else {
        nil
    }

    return try HTTPClient.Request(
        url: targetURL,
        method: HTTPMethod(request.method),
        headers: headers,
        body: body
    )
}

private func makeProxyResponse(from response: HTTPClient.Response, secretInjector: SecretInjector) -> Response {
    // Forbidden-header transport: collect Set-Cookie headers and encode as X-Proxy-Set-Cookie
    let setCookies = response.headers[canonicalForm: "set-cookie"].map { String($0) }

    var headers = HTTPFields(response.headers)
    for header in proxyBlockedResponseHeaders {
        headers[HTTPField.Name(header)!] = nil
    }
    // Strip any upstream X-Proxy-* headers to prevent spoofing
    for field in headers {
        if field.name.canonicalName.lowercased().hasPrefix("x-proxy-") {
            headers[field.name] = nil
        }
    }

    if !setCookies.isEmpty,
       let jsonData = try? JSONSerialization.data(withJSONObject: setCookies),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        headers[HTTPField.Name("X-Proxy-Set-Cookie")!] = secretInjector.scrub(text: jsonString)
    }

    // Scrub real secret values from response headers
    if !secretInjector.isEmpty {
        var scrubbedHeaders = HTTPFields()
        for field in headers {
            let scrubbedValue = secretInjector.scrub(text: field.value)
            scrubbedHeaders.append(HTTPField(name: field.name, value: scrubbedValue))
        }
        headers = scrubbedHeaders
    }

    headers[cacheControlHeader] = "no-store, no-cache"
    headers[HTTPField.Name.contentLength] = nil

    // Scrub real secret values from response body
    var responseBody = response.body ?? ByteBuffer()
    if !secretInjector.isEmpty, responseBody.readableBytes > 0,
       let bodyString = responseBody.getString(at: responseBody.readerIndex, length: responseBody.readableBytes) {
        let scrubbed = secretInjector.scrub(text: bodyString)
        if scrubbed != bodyString {
            responseBody = ByteBuffer(string: scrubbed)
        }
    }

    return Response(
        status: HTTPResponse.Status(code: Int(response.status.code), reasonPhrase: response.status.reasonPhrase),
        headers: headers,
        body: .init(byteBuffer: responseBody)
    )
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