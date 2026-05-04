import AsyncHTTPClient
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import NIOCore
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
