import AsyncHTTPClient
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import NIOCore
import NIOHTTP1
import XCTest
@testable import slicc_server

/// Tests for the `/api/s3-sign-and-forward` and `/api/da-sign-and-forward`
/// handlers and their helpers. Mirrors the validation surface covered by
/// the node-server tests in `packages/node-server/tests/secrets/sign-and-forward.test.ts`,
/// adapted to the Swift handler. Cryptography is exercised separately by
/// `SigV4SignerTests`; the tests here cover input validation, profile
/// resolution, URL construction, and the upstream-failure path.
final class SignAndForwardTests: XCTestCase {

    // Per-run profile name keeps Keychain state isolated when these tests run
    // alongside `SecretAPIRoutesTests` (or against a developer's real Keychain).
    private let profilePrefix = "SAF_TEST_\(UUID().uuidString.prefix(8))_"

    private func makeProfileName() -> String { profilePrefix + "profile" }

    override func tearDown() {
        for entry in SecretStore.list() where entry.name.hasPrefix("s3.\(profilePrefix)") {
            try? SecretStore.delete(name: entry.name)
        }
        super.tearDown()
    }

    // MARK: - profile-name validation

    func testValidProfileNameAcceptsAlphanumericAndPunctuation() {
        XCTAssertTrue(SignAndForward.isValidProfileName("default"))
        XCTAssertTrue(SignAndForward.isValidProfileName("dev-1"))
        XCTAssertTrue(SignAndForward.isValidProfileName("team.us_west"))
        XCTAssertTrue(SignAndForward.isValidProfileName("ABC123"))
    }

    func testInvalidProfileNameRejectsPathTraversalAndSpecialChars() {
        XCTAssertFalse(SignAndForward.isValidProfileName(""))
        XCTAssertFalse(SignAndForward.isValidProfileName("foo/bar"))
        XCTAssertFalse(SignAndForward.isValidProfileName("../etc"))
        XCTAssertFalse(SignAndForward.isValidProfileName("foo bar"))
        XCTAssertFalse(SignAndForward.isValidProfileName("foo;rm"))
    }

    // MARK: - profile resolution

    func testResolveS3ProfileMissingAccessKeyReturnsProfileNotConfigured() {
        let lookup: (String) -> String? = { _ in nil }
        let result = SignAndForward.resolveS3Profile(name: "missing", lookup: lookup)
        guard case .failure(.profileNotConfigured(let message)) = result else {
            return XCTFail("expected profileNotConfigured, got \(result)")
        }
        XCTAssertTrue(message.contains("access_key_id"))
        XCTAssertTrue(message.contains("secret set s3.missing.access_key_id"))
    }

    func testResolveS3ProfileMissingSecretReturnsProfileNotConfigured() {
        let lookup: (String) -> String? = { name in
            name == "s3.demo.access_key_id" ? "AKIDEXAMPLE" : nil
        }
        let result = SignAndForward.resolveS3Profile(name: "demo", lookup: lookup)
        guard case .failure(.profileNotConfigured(let message)) = result else {
            return XCTFail("expected profileNotConfigured, got \(result)")
        }
        XCTAssertTrue(message.contains("secret_access_key"))
    }

    func testResolveS3ProfileSuccessWithDefaults() {
        let lookup: (String) -> String? = { name in
            switch name {
            case "s3.demo.access_key_id": return "AKID"
            case "s3.demo.secret_access_key": return "SECRET"
            default: return nil
            }
        }
        let result = SignAndForward.resolveS3Profile(name: "demo", lookup: lookup)
        guard case .success(let profile) = result else {
            return XCTFail("expected success, got \(result)")
        }
        XCTAssertEqual(profile.accessKeyId, "AKID")
        XCTAssertEqual(profile.secretAccessKey, "SECRET")
        XCTAssertNil(profile.sessionToken)
        XCTAssertEqual(profile.region, "us-east-1")
        XCTAssertNil(profile.endpoint)
        XCTAssertFalse(profile.pathStyle)
    }

    func testResolveS3ProfileSuccessWithAllFields() {
        let lookup: (String) -> String? = { name in
            switch name {
            case "s3.r2.access_key_id": return "AKID"
            case "s3.r2.secret_access_key": return "SECRET"
            case "s3.r2.session_token": return "TOKEN"
            case "s3.r2.region": return "auto"
            case "s3.r2.endpoint": return "https://r2.cloudflarestorage.com"
            case "s3.r2.path_style": return "true"
            default: return nil
            }
        }
        let result = SignAndForward.resolveS3Profile(name: "r2", lookup: lookup)
        guard case .success(let profile) = result else {
            return XCTFail("expected success, got \(result)")
        }
        XCTAssertEqual(profile.sessionToken, "TOKEN")
        XCTAssertEqual(profile.region, "auto")
        XCTAssertEqual(profile.endpoint, "https://r2.cloudflarestorage.com")
        XCTAssertTrue(profile.pathStyle)
    }

    // MARK: - URL construction

    func testBuildS3URLVirtualHosted() {
        let profile = SignAndForward.S3Profile(
            accessKeyId: "k", secretAccessKey: "s", sessionToken: nil,
            region: "us-east-1", endpoint: nil, pathStyle: false
        )
        let result = SignAndForward.buildS3URL(profile: profile, bucket: "my-bucket", key: "foo/bar.txt", query: nil)
        guard case .success(let url) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(url.absoluteString, "https://my-bucket.s3.us-east-1.amazonaws.com/foo/bar.txt")
    }

    func testBuildS3URLPathStyle() {
        let profile = SignAndForward.S3Profile(
            accessKeyId: "k", secretAccessKey: "s", sessionToken: nil,
            region: "us-east-1", endpoint: nil, pathStyle: true
        )
        let result = SignAndForward.buildS3URL(profile: profile, bucket: "my-bucket", key: "foo/bar.txt", query: nil)
        guard case .success(let url) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(url.absoluteString, "https://s3.us-east-1.amazonaws.com/my-bucket/foo/bar.txt")
    }

    func testBuildS3URLCustomEndpointForR2() {
        let profile = SignAndForward.S3Profile(
            accessKeyId: "k", secretAccessKey: "s", sessionToken: nil,
            region: "auto", endpoint: "https://abc.r2.cloudflarestorage.com", pathStyle: false
        )
        let result = SignAndForward.buildS3URL(profile: profile, bucket: "demo", key: "x.txt", query: nil)
        guard case .success(let url) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(url.absoluteString, "https://demo.abc.r2.cloudflarestorage.com/x.txt")
    }

    func testBuildS3URLEncodesSpecialKeyCharsButPreservesSlash() {
        let profile = SignAndForward.S3Profile(
            accessKeyId: "k", secretAccessKey: "s", sessionToken: nil,
            region: "us-east-1", endpoint: nil, pathStyle: false
        )
        let result = SignAndForward.buildS3URL(profile: profile, bucket: "b", key: "a b/c+d.txt", query: nil)
        guard case .success(let url) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertEqual(url.absoluteString, "https://b.s3.us-east-1.amazonaws.com/a%20b/c%2Bd.txt")
    }

    func testBuildS3URLAddsQueryParameters() {
        let profile = SignAndForward.S3Profile(
            accessKeyId: "k", secretAccessKey: "s", sessionToken: nil,
            region: "us-east-1", endpoint: nil, pathStyle: false
        )
        let result = SignAndForward.buildS3URL(
            profile: profile, bucket: "b", key: "",
            query: ["list-type": "2", "prefix": "foo"]
        )
        guard case .success(let url) = result else { return XCTFail("expected success, got \(result)") }
        XCTAssertTrue(url.absoluteString.hasPrefix("https://b.s3.us-east-1.amazonaws.com/?"))
        XCTAssertTrue(url.absoluteString.contains("list-type=2"))
        XCTAssertTrue(url.absoluteString.contains("prefix=foo"))
    }

    func testBuildS3URLInvalidEndpointReturnsFailure() {
        let profile = SignAndForward.S3Profile(
            accessKeyId: "k", secretAccessKey: "s", sessionToken: nil,
            region: "us-east-1", endpoint: "not a url", pathStyle: false
        )
        let result = SignAndForward.buildS3URL(profile: profile, bucket: "b", key: "x", query: nil)
        if case .failure(.invalidEndpoint(let message)) = result {
            XCTAssertTrue(message.contains("not a url"))
        } else {
            XCTFail("expected invalidEndpoint, got \(result)")
        }
    }

    // MARK: - percent-encoding helper

    func testPercentEncodeURIComponentMatchesEncodeURIComponent() {
        XCTAssertEqual(SignAndForward.percentEncodeURIComponent("foo bar"), "foo%20bar")
        XCTAssertEqual(SignAndForward.percentEncodeURIComponent("a+b"), "a%2Bb")
        XCTAssertEqual(SignAndForward.percentEncodeURIComponent("hello"), "hello")
        XCTAssertEqual(SignAndForward.percentEncodeURIComponent("~-_."), "~-_.")
        XCTAssertEqual(SignAndForward.percentEncodeURIComponent("/?&="), "%2F%3F%26%3D")
    }

    // MARK: - S3 endpoint validation

    func testS3HandlerRejectsInvalidProfile() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/s3-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"profile":"bad/name","method":"GET","bucket":"b","key":"k"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                    let envelope = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(envelope["ok"], .bool(false))
                    XCTAssertEqual(envelope["errorCode"], .string("invalid_profile"))
                }
            }
        }
    }

    func testS3HandlerRejectsInvalidMethod() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/s3-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"profile":"default","method":"PATCH","bucket":"b","key":"k"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                    let envelope = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(envelope["errorCode"], .string("invalid_request"))
                }
            }
        }
    }

    func testS3HandlerRejectsMissingBucket() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/s3-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"profile":"default","method":"GET","bucket":"","key":"k"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                    let envelope = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(envelope["errorCode"], .string("invalid_request"))
                }
            }
        }
    }

    func testS3HandlerRejectsInvalidBase64Body() async throws {
        let name = makeProfileName()
        try SecretStore.set(name: "s3.\(name).access_key_id", value: "AKID", domains: ["*"])
        try SecretStore.set(name: "s3.\(name).secret_access_key", value: "SECRET", domains: ["*"])
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = "{\"profile\":\"\(name)\",\"method\":\"PUT\",\"bucket\":\"b\",\"key\":\"k\",\"bodyBase64\":\"!!! not base64 !!!\"}"
                try await client.execute(
                    uri: "/api/s3-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                    let envelope = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(envelope["errorCode"], .string("invalid_request"))
                }
            }
        }
    }

    func testS3HandlerReturnsBadGatewayWhenProfilePointsAtUnreachableEndpoint() async throws {
        let name = makeProfileName()
        try SecretStore.set(name: "s3.\(name).access_key_id", value: "AKID", domains: ["*"])
        try SecretStore.set(name: "s3.\(name).secret_access_key", value: "SECRET", domains: ["*"])
        // Port 1 is unassigned by IANA — connect attempts fail fast.
        try SecretStore.set(name: "s3.\(name).endpoint", value: "http://127.0.0.1:1", domains: ["*"])
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                let body = "{\"profile\":\"\(name)\",\"method\":\"GET\",\"bucket\":\"b\",\"key\":\"x\"}"
                try await client.execute(
                    uri: "/api/s3-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: body)
                ) { response in
                    XCTAssertEqual(response.status, .badGateway)
                    let envelope = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(envelope["errorCode"], .string("fetch_failed"))
                }
            }
        }
    }

    // MARK: - DA endpoint validation

    func testDaHandlerRejectsMissingImsToken() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/da-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"method":"GET","path":"/source/foo/bar"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                    let envelope = try self.decodeJSONObject(from: response.body)
                    XCTAssertTrue(envelope["error"]?.stringValue?.contains("imsToken") ?? false)
                }
            }
        }
    }

    func testDaHandlerRejectsPathWithoutLeadingSlash() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/da-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"imsToken":"t","method":"GET","path":"source/foo/bar"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                    let envelope = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(envelope["errorCode"], .string("invalid_request"))
                }
            }
        }
    }

    func testDaHandlerRejectsInvalidMethod() async throws {
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/da-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"imsToken":"t","method":"PATCH","path":"/source/foo/bar"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                }
            }
        }
    }

    func testDaHandlerRejectsEmptyImsToken() async throws {
        // Mirrors the node-server suite's separate "empty imsToken" case.
        // Confirms the `!isEmpty` guard works in addition to the missing-key
        // path tested above.
        try await withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/da-sign-and-forward",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"imsToken":"","method":"GET","path":"/source/foo/bar"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .badRequest)
                    let envelope = try self.decodeJSONObject(from: response.body)
                    XCTAssertTrue(envelope["error"]?.stringValue?.contains("imsToken") ?? false)
                }
            }
        }
    }

    // MARK: - Wire-level success-path tests
    //
    // These tests close the gap the node-server suite uses
    // `installFetchMock` to cover: byte-level parity between what the JS
    // handler puts on the wire and what the Swift handler does. Rather
    // than stand up TLS infrastructure for an https upstream — which the
    // signer-side hardcodes in `buildS3URL` — we exercise the request
    // builder and envelope builder directly. The signer is already
    // proven byte-identical to the JS signer by `SigV4SignerTests`; what
    // these tests prove is that the handler propagates that signature
    // (plus the SigV4-mandated headers) into the AHC request unchanged.

    func testPrepareForwardRequestPropagatesSignedHeaders() throws {
        let url = URL(string: "https://my-bucket.s3.us-east-1.amazonaws.com/foo.txt")!
        let signed = SigV4Signer.sign(
            SigV4Request(method: .GET, url: url, headers: ["host": url.host!]),
            credentials: SigV4Credentials(accessKeyId: "AKIDEXAMPLE", secretAccessKey: "SECRET"),
            region: "us-east-1",
            service: "s3"
        )
        let prepared = SignAndForward.prepareForwardRequest(
            url: url, method: signed.method, headers: signed.headers, body: signed.body
        )
        XCTAssertEqual(prepared.method, .GET)
        XCTAssertEqual(prepared.url, url.absoluteString)
        // Every signer-emitted header must reach the prepared request (except
        // host, which AHC sets from the URL itself).
        XCTAssertNotNil(prepared.headers["Authorization"])
        XCTAssertTrue(prepared.headers["Authorization"]!.hasPrefix("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"))
        XCTAssertNotNil(prepared.headers["x-amz-date"])
        XCTAssertEqual(
            prepared.headers["x-amz-content-sha256"],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        // Host is dropped — AHC sets it from the URL. Either case must be absent.
        XCTAssertNil(prepared.headers["Host"])
        XCTAssertNil(prepared.headers["host"])
    }

    func testPrepareForwardRequestRoundTripsBodyOnPut() {
        let url = URL(string: "https://b.s3.us-east-1.amazonaws.com/foo.txt")!
        let body = Data("hello world".utf8)
        let prepared = SignAndForward.prepareForwardRequest(
            url: url, method: .PUT, headers: [:], body: body
        )
        XCTAssertEqual(prepared.method, .PUT)
        XCTAssertEqual(prepared.body, body)
    }

    func testPrepareForwardRequestSuppressesBodyOnGetEvenIfProvided() {
        // S3 rejects GET requests with a Content-Length header. AHC adds
        // Content-Length whenever .body is set, even to empty bytes — so
        // the Swift handler explicitly skips body assignment on GET/HEAD.
        let url = URL(string: "https://b.s3.us-east-1.amazonaws.com/foo.txt")!
        let body = Data("ignored".utf8)
        let prepared = SignAndForward.prepareForwardRequest(
            url: url, method: .GET, headers: [:], body: body
        )
        XCTAssertNil(prepared.body, "GET requests must never carry a body to S3")
    }

    func testPrepareForwardRequestSuppressesBodyOnHead() {
        let url = URL(string: "https://b.s3.us-east-1.amazonaws.com/foo.txt")!
        let prepared = SignAndForward.prepareForwardRequest(
            url: url, method: .HEAD, headers: [:], body: Data("ignored".utf8)
        )
        XCTAssertNil(prepared.body)
    }

    func testBuildSuccessEnvelopeStripsHopByHopHeaders() {
        var headers = HTTPHeaders()
        headers.add(name: "ETag", value: "\"abc\"")
        headers.add(name: "Content-Type", value: "text/plain")
        // Hop-by-hop entries — must be stripped per RFC 7230.
        headers.add(name: "Connection", value: "close")
        headers.add(name: "Transfer-Encoding", value: "chunked")
        headers.add(name: "Keep-Alive", value: "timeout=5")
        headers.add(name: "Proxy-Authorization", value: "Bearer leak-me-please")

        let envelope = SignAndForward.buildSuccessEnvelope(
            status: 200, headers: headers, body: ByteBuffer(string: "hi")
        )
        guard case .object(let obj) = envelope else { return XCTFail("expected object envelope") }
        XCTAssertEqual(obj["ok"], .bool(true))
        XCTAssertEqual(obj["status"], .number(200))
        guard case .object(let envHeaders) = obj["headers"]! else {
            return XCTFail("envelope.headers must be an object")
        }
        // Pass-through headers survive.
        XCTAssertNotNil(envHeaders["ETag"], "ETag must pass through")
        XCTAssertNotNil(envHeaders["Content-Type"])
        // Hop-by-hop headers are stripped.
        XCTAssertNil(envHeaders["Connection"])
        XCTAssertNil(envHeaders["Transfer-Encoding"])
        XCTAssertNil(envHeaders["Keep-Alive"])
        XCTAssertNil(envHeaders["Proxy-Authorization"], "credentials-bearing hop-by-hop must NOT leak to client")
    }

    func testBuildSuccessEnvelopeBase64RoundTrips() {
        let original = "hello world\n\u{1F4A9}".data(using: .utf8)!  // includes a non-ASCII codepoint
        let envelope = SignAndForward.buildSuccessEnvelope(
            status: 200, headers: HTTPHeaders(), body: ByteBuffer(bytes: original)
        )
        guard case .object(let obj) = envelope,
              case .string(let b64) = obj["bodyBase64"] else {
            return XCTFail("expected envelope with bodyBase64 string")
        }
        let decoded = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters])
        XCTAssertEqual(decoded, original)
    }

    // MARK: - DA end-to-end test against a local stub

    /// Runs the full DA handler against a local Hummingbird upstream stub.
    /// Possible because `daOrigin` is injectable (production hardcodes
    /// `https://admin.da.live`; this test points at `http://127.0.0.1:<port>`).
    /// Captures the upstream request and asserts on:
    ///   * the URL we forwarded to (origin + path + sorted query params)
    ///   * `Authorization: Bearer <imsToken>` attached
    ///   * arbitrary client-supplied headers passed through
    ///   * request body round-trips intact
    /// And on the response envelope:
    ///   * status forwarded
    ///   * upstream headers forwarded (with hop-by-hop stripping)
    ///   * upstream body base64 round-trips
    func testDaEndToEndCapturesSignedRequestAndForwardsResponse() async throws {
        let captured = CapturedUpstreamRequest()

        let upstreamRouter = Router()
        upstreamRouter.on("/source/foo/bar/baz.html", method: .post) { request, _ in
            // Capture the request so the test can assert on it after.
            let body = try await request.body.collect(upTo: 1024 * 1024)
            await captured.record(
                method: "POST",
                path: String(request.uri.path),
                query: request.uri.query.map { String($0) } ?? "",
                authorization: request.headers[HTTPField.Name("Authorization")!],
                contentType: request.headers[HTTPField.Name("Content-Type")!],
                bodyBytes: Array(body.readableBytesView)
            )
            // Canned response with hop-by-hop and pass-through headers,
            // so the envelope-level filtering is exercised here too.
            var responseHeaders: HTTPFields = [:]
            responseHeaders[HTTPField.Name("ETag")!] = "\"upstream-tag\""
            responseHeaders[HTTPField.Name("Content-Type")!] = "text/plain"
            responseHeaders[HTTPField.Name("Connection")!] = "close"
            return Response(
                status: .created,
                headers: responseHeaders,
                body: .init(byteBuffer: ByteBuffer(string: "stub-ok"))
            )
        }
        let upstreamConfig = ApplicationConfiguration(address: .hostname("127.0.0.1", port: 0))
        let upstreamApp = Application(
            responder: upstreamRouter.buildResponder(),
            configuration: upstreamConfig
        )

        try await upstreamApp.test(.live) { upstreamClient in
            let upstreamPort = upstreamClient.port
            let daOrigin = "http://127.0.0.1:\(upstreamPort)"
            // Pre-flight: prove the daOrigin string is parseable AND that
            // .url survives query-item mutation, since the SUT does both
            // and a failure in either looks the same in the error envelope.
            guard var pre = URLComponents(string: daOrigin + "/source/foo/bar/baz.html") else {
                return XCTFail("daOrigin produced a string URLComponents rejects: \(daOrigin)")
            }
            pre.queryItems = [URLQueryItem(name: "editor", value: "0"), URLQueryItem(name: "preview", value: "1")]
            XCTAssertNotNil(
                pre.url,
                "URLComponents.url is nil after queryItems mutation (port: \(upstreamPort), daOrigin: \(daOrigin))"
            )

            try await self.withHTTPClient { httpClient in
                let router = Router()
                // Wire the SUT with our stub origin overriding the production
                // `https://admin.da.live`.
                SignAndForward.registerRoutes(router: router, httpClient: httpClient, daOrigin: daOrigin)

                let app = Application(responder: router.buildResponder())
                try await app.test(.router) { client in
                    let envelope = #"""
                    {
                      "imsToken": "secret-bearer-XYZ",
                      "method": "POST",
                      "path": "/source/foo/bar/baz.html",
                      "query": {"editor": "0", "preview": "1"},
                      "headers": {"Content-Type": "text/html"},
                      "bodyBase64": "PGgxPmhpPC9oMT4="
                    }
                    """#
                    try await client.execute(
                        uri: "/api/da-sign-and-forward",
                        method: .post,
                        headers: [.contentType: "application/json"],
                        body: ByteBuffer(string: envelope)
                    ) { response in
                        // Surface the SUT's error envelope on non-200 — without
                        // this the assertion only sees "400 Bad Request" with
                        // no clue which validation guard fired.
                        guard response.status == .ok else {
                            return XCTFail("expected 200 OK; got \(response.status). body: \(String(buffer: response.body))")
                        }
                        let env = try self.decodeJSONObject(from: response.body)
                        XCTAssertEqual(env["ok"], .bool(true))
                        XCTAssertEqual(env["status"], .number(201))

                        // Body round-trip.
                        guard case .string(let b64) = env["bodyBase64"] else {
                            return XCTFail("expected bodyBase64 string in success envelope")
                        }
                        XCTAssertEqual(
                            Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]).flatMap { String(data: $0, encoding: .utf8) },
                            "stub-ok"
                        )
                        // Pass-through + hop-by-hop strip on response.
                        if case .object(let respHeaders) = env["headers"] {
                            XCTAssertNotNil(respHeaders["ETag"])
                            XCTAssertNil(respHeaders["Connection"], "Connection must be stripped")
                        } else {
                            XCTFail("envelope.headers must be an object")
                        }
                    }

                    // Now assert what the upstream actually received.
                    let snapshot = await captured.snapshot()
                    XCTAssertEqual(snapshot?.method, "POST")
                    XCTAssertEqual(snapshot?.path, "/source/foo/bar/baz.html")
                    // Query params are sorted by key.
                    XCTAssertEqual(snapshot?.query, "editor=0&preview=1")
                    // IMS bearer attached.
                    XCTAssertEqual(snapshot?.authorization, "Bearer secret-bearer-XYZ")
                    // Caller-supplied Content-Type passed through.
                    XCTAssertEqual(snapshot?.contentType, "text/html")
                    // Body round-tripped intact.
                    XCTAssertEqual(snapshot?.bodyBytes.flatMap { String(bytes: $0, encoding: .utf8) }, "<h1>hi</h1>")
                }
            }
        }
    }

    // MARK: - Helpers

    private func makeConfig() -> ServerConfig {
        .init(
            dev: true,
            serveOnly: false,
            cdpPort: 9222,
            explicitCdpPort: false,
            electron: false,
            electronApp: nil,
            electronAppURL: nil,
            kill: false,
            lead: false,
            leadWorkerBaseUrl: nil,
            leadWorkerBaseURL: nil,
            profile: nil,
            join: false,
            joinUrl: nil,
            joinURL: nil,
            logLevel: "info",
            logDir: nil,
            logDirectoryURL: nil,
            prompt: nil,
            staticRoot: nil,
            envFile: nil,
            envFileURL: nil
        )
    }

    private func decodeJSONObject(from buffer: ByteBuffer) throws -> LickSystem.JSONObject {
        try JSONDecoder().decode(LickSystem.JSONObject.self, from: Data(String(buffer: buffer).utf8))
    }

    private func withHTTPClient(
        _ body: (HTTPClient) async throws -> Void
    ) async throws {
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        do {
            try await body(httpClient)
            try await httpClient.shutdown()
        } catch {
            try? await httpClient.shutdown()
            throw error
        }
    }
}

/// Thread-safe single-slot recorder used by the DA end-to-end test to
/// capture exactly what the upstream stub received from the SUT.
private actor CapturedUpstreamRequest {
    struct Snapshot: Sendable {
        let method: String
        let path: String
        let query: String
        let authorization: String?
        let contentType: String?
        let bodyBytes: [UInt8]?
    }

    private var snap: Snapshot?

    func record(
        method: String,
        path: String,
        query: String,
        authorization: String?,
        contentType: String?,
        bodyBytes: [UInt8]?
    ) {
        self.snap = Snapshot(
            method: method,
            path: path,
            query: query,
            authorization: authorization,
            contentType: contentType,
            bodyBytes: bodyBytes
        )
    }

    func snapshot() -> Snapshot? { snap }
}
