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

    /// Methods we permit through the signed proxies.
    static let allowedMethods: Set<String> = ["GET", "PUT", "POST", "DELETE", "HEAD"]

    /// Allowed characters in profile names — restricts secret-key path traversal.
    /// `^[a-zA-Z0-9._-]+$` expressed as a character predicate to avoid pulling in
    /// NSRegularExpression for one match.
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

    /// Adobe da.live API origin. Hard-coded — clients send only the path component.
    static let daOrigin = "https://admin.da.live"

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
    static func registerRoutes(
        router: Router<some RequestContext>,
        httpClient: HTTPClient
    ) {
        router.post("/api/s3-sign-and-forward") { request, _ in
            await handleS3(request: request, httpClient: httpClient)
        }
        router.post("/api/da-sign-and-forward") { request, _ in
            await handleDa(request: request, httpClient: httpClient)
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
        guard let method = env.method, allowedMethods.contains(method) else {
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
            guard let decoded = Data(base64Encoded: b64) else {
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
        httpClient: HTTPClient
    ) async -> Response {
        let env: DaEnvelope
        do {
            env = try await decodeEnvelope(request: request)
        } catch {
            return errorResponse(.badRequest, error: "invalid JSON body", errorCode: "invalid_request")
        }

        guard let imsToken = env.imsToken, !imsToken.isEmpty else {
            return errorResponse(.badRequest, error: "imsToken is required", errorCode: "invalid_request")
        }
        guard let method = env.method, allowedMethods.contains(method) else {
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
            guard let decoded = Data(base64Encoded: b64) else {
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

    private static func decodeEnvelope<T: Decodable>(request: Request) async throws -> T {
        let buffer = try await request.body.collect(upTo: 50 * 1024 * 1024)
        var b = buffer
        let data = b.readData(length: b.readableBytes) ?? Data()
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Forward a signed request to the upstream and wrap the response in
    /// the JSON envelope shape: `{ ok: true, status, headers, bodyBase64 }`.
    /// Network failures return a 502 envelope with `errorCode: "fetch_failed"`.
    private static func forward(
        url: URL,
        method: String,
        headers: [String: String],
        body: Data?,
        httpClient: HTTPClient,
        failureLabel: String
    ) async -> Response {
        var clientRequest = HTTPClientRequest(url: url.absoluteString)
        clientRequest.method = httpMethod(from: method)
        for (name, value) in headers {
            // Skip Host — AHC sets it from the URL.
            if name.lowercased() == "host" { continue }
            clientRequest.headers.add(name: name, value: value)
        }
        if let body, !body.isEmpty, method != "GET" && method != "HEAD" {
            clientRequest.body = .bytes(ByteBuffer(bytes: body))
        }

        let upstream: HTTPClientResponse
        do {
            upstream = try await httpClient.execute(clientRequest, timeout: .seconds(60))
        } catch {
            return errorResponse(
                .badGateway,
                error: "\(failureLabel) fetch failed: \(error.localizedDescription)",
                errorCode: "fetch_failed"
            )
        }

        let bodyBuffer: ByteBuffer
        do {
            bodyBuffer = try await upstream.body.collect(upTo: 50 * 1024 * 1024)
        } catch {
            return errorResponse(
                .badGateway,
                error: "\(failureLabel) fetch failed: \(error.localizedDescription)",
                errorCode: "fetch_failed"
            )
        }

        let upstreamBytes = bodyBuffer.getBytes(at: bodyBuffer.readerIndex, length: bodyBuffer.readableBytes) ?? []
        let bodyBase64 = Data(upstreamBytes).base64EncodedString()

        var headerObject: [String: LickSystem.JSONValue] = [:]
        for header in upstream.headers {
            if hopByHopHeaders.contains(header.name.lowercased()) { continue }
            headerObject[header.name] = .string(header.value)
        }

        let envelope: LickSystem.JSONValue = .object([
            "ok": .bool(true),
            "status": .number(Double(upstream.status.code)),
            "headers": .object(headerObject),
            "bodyBase64": .string(bodyBase64),
        ])
        return jsonEnvelopeResponse(envelope, status: .ok)
    }

    /// Map our string-typed `SigV4Request.method` (always one of the entries
    /// in `allowedMethods`) to NIO's `HTTPMethod` for AHC. We pre-validate so
    /// the `default` branch is unreachable in practice; we map it to `.RAW`
    /// rather than crashing as a defensive fallback.
    private static func httpMethod(from method: String) -> HTTPMethod {
        switch method {
        case "GET": return .GET
        case "PUT": return .PUT
        case "POST": return .POST
        case "DELETE": return .DELETE
        case "HEAD": return .HEAD
        default: return .RAW(value: method)
        }
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
