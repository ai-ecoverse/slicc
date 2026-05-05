import AsyncHTTPClient
import Foundation
import HTTPTypes
import Hummingbird
import NIOCore
import NIOHTTP1

/// Server-side request signing for S3 and Adobe da.live mounts.
///
/// **Mirrors `packages/node-server/src/secrets/sign-and-forward.ts`.** Both
/// endpoints validate a JSON envelope, resolve credentials server-side
/// (S3 from Keychain via `SecretStore`, DA from a transient `imsToken` in
/// the envelope), reconstruct the upstream URL from profile config (S3) or
/// the path prefix (DA) — so the browser cannot SSRF arbitrary hosts —
/// then sign with SigV4 v4 (S3) or attach `Authorization: Bearer` (DA),
/// forward to the upstream, and return a JSON envelope.
///
/// Logging contract: never log envelope contents — request bodies or the
/// `imsToken` may contain credential material.
enum SignAndForward {

    // MARK: - Constants

    /// Allowed characters in profile names — restricts secret-key path traversal.
    /// `^[a-zA-Z0-9._-]+$` expressed as a character predicate to avoid pulling in
    /// NSRegularExpression for one match.
    ///
    /// **Kept in sync with `SecretNameValidator.isValid` in swift-launcher**
    /// (`packages/swift-launcher/Sliccstart/Views/SettingsView.swift`). Tighten
    /// only after updating both sides — narrowing the server alone would silently
    /// reject names the UI claimed to save.
    static func isValidProfileName(_ name: String) -> Bool {
        guard !name.isEmpty else { return false }
        for ch in name.unicodeScalars {
            let v = ch.value
            let alpha = (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A)
            let digit = v >= 0x30 && v <= 0x39
            let punct = v == 0x2E || v == 0x5F || v == 0x2D  // . _ -
            if !(alpha || digit || punct) { return false }
        }
        return true
    }

    /// Hop-by-hop headers per RFC 7230 — connection-scoped, must not propagate.
    static let hopByHopHeaders: Set<String> = [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ]

    /// Adobe da.live API origin used in production. Tests inject a localhost
    /// stub via the `daOrigin` parameter on `registerRoutes` / `handleDa` so
    /// they can verify the bytes we put on the wire end-to-end.
    static let defaultDaOrigin = "https://admin.da.live"

    // MARK: - Envelope shapes

    struct S3Envelope: Decodable {
        let profile: String?
        let method: String?
        let bucket: String?
        let key: String?
        let query: [String: String]?
        let headers: [String: String]?
        let bodyBase64: String?
    }

    struct DaEnvelope: Decodable {
        let imsToken: String?
        let method: String?
        let path: String?
        let query: [String: String]?
        let headers: [String: String]?
        let bodyBase64: String?
    }

    // MARK: - S3 profile resolution

    struct S3Profile: Equatable {
        let accessKeyId: String
        let secretAccessKey: String
        let sessionToken: String?
        let region: String
        let endpoint: String?
        let pathStyle: Bool
    }

    enum SignAndForwardError: Error, Equatable {
        case profileNotConfigured(message: String)
        case invalidEndpoint(message: String)
    }

    /// Resolve an S3 profile from Keychain. Mirrors `resolveS3Profile` in the
    /// node-server handler. Missing access_key_id / secret_access_key surfaces
    /// as a `profileNotConfigured` error with a help string pointing at the
    /// `secret set` command.
    static func resolveS3Profile(name: String, lookup: (String) -> String? = defaultSecretLookup) -> Result<S3Profile, SignAndForwardError> {
        guard let accessKeyId = lookup("s3.\(name).access_key_id"), !accessKeyId.isEmpty else {
            return .failure(.profileNotConfigured(
                message: "profile '\(name)' missing required field 'access_key_id'. "
                    + "Set it via: secret set s3.\(name).access_key_id <value>"
            ))
        }
        guard let secretAccessKey = lookup("s3.\(name).secret_access_key"), !secretAccessKey.isEmpty else {
            return .failure(.profileNotConfigured(
                message: "profile '\(name)' missing required field 'secret_access_key'. "
                    + "Set it via: secret set s3.\(name).secret_access_key <value>"
            ))
        }
        return .success(S3Profile(
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
            sessionToken: lookup("s3.\(name).session_token"),
            region: lookup("s3.\(name).region") ?? "us-east-1",
            endpoint: lookup("s3.\(name).endpoint"),
            pathStyle: lookup("s3.\(name).path_style") == "true"
        ))
    }

    /// Default lookup that reads from the macOS Keychain via `SecretStore`.
    /// Tests inject a stub via the `lookup` parameter on `resolveS3Profile`.
    static func defaultSecretLookup(_ name: String) -> String? {
        SecretStore.get(name: name)?.value
    }

    // MARK: - URL construction

    /// Build the S3 URL based on profile addressing style. Mirrors
    /// `buildS3Url` in the node-server handler. Keeps `/` separators inside
    /// the encoded key path; encodes the bucket as a single component.
    static func buildS3URL(profile: S3Profile, bucket: String, key: String, query: [String: String]?) -> Result<URL, SignAndForwardError> {
        let host: String
        if let endpoint = profile.endpoint {
            guard let endpointURL = URL(string: endpoint), let endpointHost = endpointURL.host, !endpointHost.isEmpty else {
                return .failure(.invalidEndpoint(message: "profile endpoint is not a valid URL: \(endpoint)"))
            }
            host = endpointHost
        } else {
            host = "s3.\(profile.region).amazonaws.com"
        }

        // Encode the key segment by segment so `/` separators are preserved.
        let encodedKey = key.split(separator: "/", omittingEmptySubsequences: false)
            .map { percentEncodeURIComponent(String($0)) }
            .joined(separator: "/")
        let encodedBucket = percentEncodeURIComponent(bucket)

        let pathPart = profile.pathStyle ? "\(encodedBucket)/\(encodedKey)" : encodedKey
        let hostPart = profile.pathStyle ? host : "\(encodedBucket).\(host)"

        var components = URLComponents()
        components.scheme = "https"
        components.host = hostPart
        // Use percentEncodedPath so URLComponents doesn't double-encode our
        // already-encoded segments.
        components.percentEncodedPath = "/\(pathPart)"
        if let query, !query.isEmpty {
            // Sort keys for deterministic ordering — matches what
            // URLSearchParams.set then sorting via canonicalQuery would
            // produce; the upstream still works regardless of order, but
            // determinism makes test assertions easier.
            let sortedItems = query.sorted(by: { $0.key < $1.key })
                .map { URLQueryItem(name: $0.key, value: $0.value) }
            components.queryItems = sortedItems
        }
        guard let url = components.url else {
            return .failure(.invalidEndpoint(message: "failed to build URL"))
        }
        return .success(url)
    }

    /// Encode each byte of `s` per RFC 3986 unreserved set (`A-Z a-z 0-9 - _ . ~`).
    /// Equivalent to JS `encodeURIComponent(s).replace(/[!'()*]/g, ...)`.
    static func percentEncodeURIComponent(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.utf8.count)
        for byte in s.utf8 {
            let isUnreserved = (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A)
                || (byte >= 0x30 && byte <= 0x39)
                || byte == 0x2D || byte == 0x5F || byte == 0x2E || byte == 0x7E
            if isUnreserved {
                out.append(Character(Unicode.Scalar(byte)))
            } else {
                out.append("%")
                out.append(String(format: "%02X", byte))
            }
        }
        return out
    }

    // MARK: - HTTP routing

    /// Register POST `/api/s3-sign-and-forward` and POST `/api/da-sign-and-forward`
    /// against the given router. Outbound requests use the shared `httpClient`.
    /// `daOrigin` is overridable for end-to-end tests against a local stub.
    static func registerRoutes(
        router: Router<some RequestContext>,
        httpClient: HTTPClient,
        daOrigin: String = defaultDaOrigin
    ) {
        router.post("/api/s3-sign-and-forward") { request, _ in
            await handleS3(request: request, httpClient: httpClient)
        }
        router.post("/api/da-sign-and-forward") { request, _ in
            await handleDa(request: request, httpClient: httpClient, daOrigin: daOrigin)
        }
    }

    /// Handle an S3 sign-and-forward envelope. Returns a JSON envelope
    /// `{ ok: true, status, headers, bodyBase64 }` on success or
    /// `{ ok: false, error, errorCode }` on failure (400 for invalid input,
    /// 502 for upstream fetch failures).
    static func handleS3(
        request: Request,
        httpClient: HTTPClient
    ) async -> Response {
        let env: S3Envelope
        do {
            env = try await decodeEnvelope(request: request)
        } catch is NIOTooManyBytesError {
            return errorResponse(
                .contentTooLarge,
                error: "request body exceeds \(maxEnvelopeBytesHumanReadable) limit",
                errorCode: "body_too_large"
            )
        } catch {
            return errorResponse(.badRequest, error: "invalid JSON body", errorCode: "invalid_request")
        }

        guard let profileName = env.profile, isValidProfileName(profileName) else {
            return errorResponse(
                .badRequest,
                error: "invalid profile name (allowed: alphanumeric, dot, underscore, hyphen)",
                errorCode: "invalid_profile"
            )
        }
        guard let methodStr = env.method, let method = SigV4Method(rawValue: methodStr) else {
            return errorResponse(.badRequest, error: "invalid method", errorCode: "invalid_request")
        }
        guard let bucket = env.bucket, !bucket.isEmpty else {
            return errorResponse(.badRequest, error: "invalid bucket", errorCode: "invalid_request")
        }
        guard let key = env.key else {
            return errorResponse(.badRequest, error: "invalid key", errorCode: "invalid_request")
        }

        let profile: S3Profile
        switch resolveS3Profile(name: profileName) {
        case .success(let p):
            profile = p
        case .failure(.profileNotConfigured(let message)):
            return errorResponse(.badRequest, error: message, errorCode: "profile_not_configured")
        case .failure(.invalidEndpoint(let message)):
            return errorResponse(.badRequest, error: message, errorCode: "invalid_request")
        }

        let url: URL
        switch buildS3URL(profile: profile, bucket: bucket, key: key, query: env.query) {
        case .success(let u): url = u
        case .failure(.invalidEndpoint(let message)):
            return errorResponse(.badRequest, error: message, errorCode: "invalid_request")
        case .failure(.profileNotConfigured(let message)):
            return errorResponse(.badRequest, error: message, errorCode: "invalid_request")
        }

        let body: Data?
        if let b64 = env.bodyBase64, !b64.isEmpty {
            // Permissive base64 — matches Node's `Buffer.from(b64, 'base64')`
            // (which silently ignores whitespace / unknown chars). Strict
            // decoding would reject MIME-style line-broken base64 that the
            // node-server happily accepts, so the swift- and node-server
            // surfaces would otherwise diverge on input shape.
            guard let decoded = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]) else {
                return errorResponse(.badRequest, error: "invalid bodyBase64", errorCode: "invalid_request")
            }
            body = decoded
        } else {
            body = nil
        }

        var headersForSigning = env.headers ?? [:]
        headersForSigning["Host"] = url.host ?? ""

        let signed = SigV4Signer.sign(
            SigV4Request(method: method, url: url, headers: headersForSigning, body: body),
            credentials: SigV4Credentials(
                accessKeyId: profile.accessKeyId,
                secretAccessKey: profile.secretAccessKey,
                sessionToken: profile.sessionToken
            ),
            region: profile.region,
            service: "s3"
        )

        return await forward(
            url: url,
            method: signed.method,
            headers: signed.headers,
            body: signed.body,
            httpClient: httpClient,
            failureLabel: "S3"
        )
    }

    /// Handle a DA sign-and-forward envelope. Forwards to `admin.da.live`
    /// with `Authorization: Bearer <imsToken>`. Mirrors the node-server
    /// handler — the IMS token is transient (never persisted) and the
    /// upstream origin is hard-coded so the browser cannot redirect to
    /// arbitrary hosts.
    static func handleDa(
        request: Request,
        httpClient: HTTPClient,
        daOrigin: String = defaultDaOrigin
    ) async -> Response {
        let env: DaEnvelope
        do {
            env = try await decodeEnvelope(request: request)
        } catch is NIOTooManyBytesError {
            return errorResponse(
                .contentTooLarge,
                error: "request body exceeds \(maxEnvelopeBytesHumanReadable) limit",
                errorCode: "body_too_large"
            )
        } catch {
            return errorResponse(.badRequest, error: "invalid JSON body", errorCode: "invalid_request")
        }

        guard let imsToken = env.imsToken, !imsToken.isEmpty else {
            return errorResponse(.badRequest, error: "imsToken is required", errorCode: "invalid_request")
        }
        guard let methodStr = env.method, let method = SigV4Method(rawValue: methodStr) else {
            return errorResponse(.badRequest, error: "invalid method", errorCode: "invalid_request")
        }
        guard let path = env.path, path.hasPrefix("/") else {
            return errorResponse(
                .badRequest,
                error: "path must be a string starting with /",
                errorCode: "invalid_request"
            )
        }

        guard var components = URLComponents(string: daOrigin + path) else {
            return errorResponse(.badRequest, error: "failed to build URL", errorCode: "invalid_request")
        }
        if let query = env.query, !query.isEmpty {
            let sortedItems = query.sorted(by: { $0.key < $1.key })
                .map { URLQueryItem(name: $0.key, value: $0.value) }
            let existing = components.queryItems ?? []
            components.queryItems = existing + sortedItems
        }
        guard let url = components.url else {
            return errorResponse(.badRequest, error: "failed to build URL", errorCode: "invalid_request")
        }

        let body: Data?
        if let b64 = env.bodyBase64, !b64.isEmpty {
            // See `handleS3` for the rationale on permissive base64.
            guard let decoded = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]) else {
                return errorResponse(.badRequest, error: "invalid bodyBase64", errorCode: "invalid_request")
            }
            body = decoded
        } else {
            body = nil
        }

        var headers = env.headers ?? [:]
        headers["Authorization"] = "Bearer \(imsToken)"

        return await forward(
            url: url,
            method: method,
            headers: headers,
            body: body,
            httpClient: httpClient,
            failureLabel: "DA"
        )
    }

    // MARK: - Internals

    /// Body-size cap shared by inbound envelope collection and outbound
    /// upstream-response collection. Exposed so error messages can quote
    /// the same number the code enforces.
    static let maxEnvelopeBytes = 50 * 1024 * 1024
    static let maxEnvelopeBytesHumanReadable = "50 MB"

    private static func decodeEnvelope<T: Decodable>(request: Request) async throws -> T {
        let buffer = try await request.body.collect(upTo: maxEnvelopeBytes)
        var b = buffer
        let data = b.readData(length: b.readableBytes) ?? Data()
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Inspectable shape of an outbound request. Tests assert against this;
    /// `forward()` then assembles the equivalent `HTTPClientRequest`. AHC's
    /// `HTTPClientRequest.Body` is an opaque struct (not an enum we can
    /// pattern-match), so we expose the body bytes here rather than going
    /// through AHC's representation just to inspect them.
    struct ForwardRequest: Equatable {
        let url: String
        let method: SigV4Method
        /// Headers that will be set on the AHC request. The Host header is
        /// always stripped — AHC sets it from the URL — so it never appears
        /// here. Keys are kept in their original case (callers may pass
        /// either `Authorization` or `authorization`).
        let headers: [String: String]
        /// Bytes the wire body will carry. `nil` when no body is appropriate
        /// (no input, empty input, or method is GET/HEAD).
        let body: Data?
    }

    /// Plan the upstream request without committing to AHC's opaque body
    /// type. Extracted from `forward()` so tests can assert byte-for-byte
    /// parity with the JS handler without standing up a TLS upstream.
    static func prepareForwardRequest(
        url: URL,
        method: SigV4Method,
        headers: [String: String],
        body: Data?
    ) -> ForwardRequest {
        var filtered: [String: String] = [:]
        for (name, value) in headers where name.lowercased() != "host" {
            filtered[name] = value
        }
        // AHC attaches Content-Length even for empty `.bytes(...)` bodies
        // and S3 rejects GET requests that carry a content-length header.
        // JS `fetch` strips bodies on GET/HEAD by spec, which is why the
        // node-server handler doesn't need this gate; we replicate the
        // spec-level behavior explicitly here.
        let actualBody: Data?
        if let body, !body.isEmpty, method != .GET && method != .HEAD {
            actualBody = body
        } else {
            actualBody = nil
        }
        return ForwardRequest(url: url.absoluteString, method: method, headers: filtered, body: actualBody)
    }

    /// Forward a signed request to the upstream and wrap the response in
    /// the JSON envelope shape: `{ ok: true, status, headers, bodyBase64 }`.
    /// Network failures return a 502 envelope with `errorCode: "fetch_failed"`;
    /// oversized responses return 502 with `errorCode: "response_too_large"`.
    private static func forward(
        url: URL,
        method: SigV4Method,
        headers: [String: String],
        body: Data?,
        httpClient: HTTPClient,
        failureLabel: String
    ) async -> Response {
        let prepared = prepareForwardRequest(url: url, method: method, headers: headers, body: body)
        var clientRequest = HTTPClientRequest(url: prepared.url)
        clientRequest.method = prepared.method.nioHTTPMethod
        for (name, value) in prepared.headers {
            clientRequest.headers.add(name: name, value: value)
        }
        if let body = prepared.body {
            clientRequest.body = .bytes(ByteBuffer(bytes: body))
        }

        let upstream: HTTPClientResponse
        do {
            upstream = try await httpClient.execute(clientRequest, timeout: .seconds(60))
        } catch {
            return errorResponse(
                .badGateway,
                error: "\(failureLabel) fetch failed: \(forwardErrorMessage(error))",
                errorCode: "fetch_failed"
            )
        }

        let bodyBuffer: ByteBuffer
        do {
            bodyBuffer = try await upstream.body.collect(upTo: maxEnvelopeBytes)
        } catch is NIOTooManyBytesError {
            return errorResponse(
                .badGateway,
                error: "\(failureLabel) response exceeds \(maxEnvelopeBytesHumanReadable) proxy limit",
                errorCode: "response_too_large"
            )
        } catch {
            return errorResponse(
                .badGateway,
                error: "\(failureLabel) fetch failed: \(forwardErrorMessage(error))",
                errorCode: "fetch_failed"
            )
        }

        let envelope = buildSuccessEnvelope(status: upstream.status.code, headers: upstream.headers, body: bodyBuffer)
        return jsonEnvelopeResponse(envelope, status: .ok)
    }

    /// Build the JSON envelope returned to the client on a successful forward.
    /// Hop-by-hop headers per RFC 7230 are stripped; the response body is
    /// base64-encoded. Extracted so tests can assert envelope shape, header
    /// filtering, and body round-trip without a real upstream.
    static func buildSuccessEnvelope(status: UInt, headers: HTTPHeaders, body: ByteBuffer) -> LickSystem.JSONValue {
        let upstreamBytes = body.getBytes(at: body.readerIndex, length: body.readableBytes) ?? []
        let bodyBase64 = Data(upstreamBytes).base64EncodedString()

        var headerObject: [String: LickSystem.JSONValue] = [:]
        for header in headers {
            if hopByHopHeaders.contains(header.name.lowercased()) { continue }
            headerObject[header.name] = .string(header.value)
        }

        return .object([
            "ok": .bool(true),
            "status": .number(Double(status)),
            "headers": .object(headerObject),
            "bodyBase64": .string(bodyBase64),
        ])
    }

    /// Render an AHC / NIO error in a form useful to a debugging operator.
    /// `error.localizedDescription` returns the misleading
    /// `"The operation could not be completed."` Cocoa default for many
    /// NIO error types, so we prefer `String(describing:)` (which yields
    /// case names like `connectTimeout` for `HTTPClientError`) and fall
    /// back only when that produces something obviously empty.
    private static func forwardErrorMessage(_ error: Error) -> String {
        let described = String(describing: error)
        if !described.isEmpty { return described }
        return error.localizedDescription
    }

    private static func errorResponse(_ status: HTTPResponse.Status, error: String, errorCode: String) -> Response {
        let envelope: LickSystem.JSONValue = .object([
            "ok": .bool(false),
            "error": .string(error),
            "errorCode": .string(errorCode),
        ])
        return jsonEnvelopeResponse(envelope, status: status)
    }

    private static func jsonEnvelopeResponse(_ value: LickSystem.JSONValue, status: HTTPResponse.Status) -> Response {
        let data: Data
        do {
            data = try JSONEncoder().encode(value)
        } catch {
            return Response(
                status: .internalServerError,
                headers: [.contentType: "application/json; charset=utf-8"],
                body: .init(byteBuffer: ByteBuffer(string: #"{"ok":false,"error":"failed to encode envelope","errorCode":"internal_error"}"#))
            )
        }
        return Response(
            status: status,
            headers: [.contentType: "application/json; charset=utf-8"],
            body: .init(byteBuffer: ByteBuffer(bytes: data))
        )
    }
}

extension SigV4Method {
    /// Map the closed `SigV4Method` enum to NIO's open `HTTPMethod`. Lives
    /// here (next to the only consumer) rather than in `SigV4Signer.swift`
    /// so the signer module doesn't need to import `NIOHTTP1`.
    var nioHTTPMethod: HTTPMethod {
        switch self {
        case .GET: return .GET
        case .PUT: return .PUT
        case .POST: return .POST
        case .DELETE: return .DELETE
        case .HEAD: return .HEAD
        }
    }
}
