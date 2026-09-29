import AsyncHTTPClient
import CommonCrypto
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import NIOCore
import NIOHTTP1
import XCTest

@testable import slicc_server

/// Raw mode of `/api/fetch-proxy` (#3571), driven end-to-end like
/// node-server's `fetch-proxy-raw.test.ts`: the real route table from
/// `registerAPIRoutes` served live, a live upstream, and an AsyncHTTPClient
/// talking to the bridge the way the webapp's hop does.
final class RawFetchProxyTests: XCTestCase {
    private static let token = "ghp_rawmode0123456789abcdefghijk"
    private static let masked = "ghp_masked0123456789abcdefghijk"

    private struct Seen: Sendable {
        let method: String
        let path: String
        let headers: HTTPFields
        let body: [UInt8]
    }

    private actor SeenBox {
        private(set) var requests: [Seen] = []
        func add(_ seen: Seen) { requests.append(seen) }
    }

    /// What the upstream answers, given the request it saw.
    private struct Upstream: Sendable {
        let respond: @Sendable (Seen) async throws -> Response

        init(_ respond: @escaping @Sendable (Seen) async throws -> Response) {
            self.respond = respond
        }
    }

    private struct Harness: Sendable {
        let origin: String
        let bridge: String
        let client: HTTPClient
        let seen: SeenBox
        let activity: AgentActivityTracker
    }

    private struct RawResult {
        let status: Int
        let contentType: String?
        let head: RawFetchResponseHead
        let body: [UInt8]
    }

    private struct ProxyError: Error {
        let status: Int
        let message: String
    }

    // MARK: - Harness

    /// Serve `respond` as the upstream (it sees the whole request body) and
    /// the bridge in front of it, then run `body`.
    private func withHarness(
        secretDomains: [String] = ["localhost"],
        maxRequestBodyBytes: Int? = nil,
        upstream: Upstream,
        _ body: (Harness) async throws -> Void
    ) async throws {
        let seen = SeenBox()
        let upstreamApp = Application(
            responder: CallbackResponder<BasicRequestContext> { request, _ in
                let bytes = try await request.body.collect(upTo: .max)
                let record = Seen(
                    method: request.method.rawValue,
                    path: request.uri.string,
                    headers: request.headers,
                    body: Array(bytes.readableBytesView)
                )
                await seen.add(record)
                return try await upstream.respond(record)
            }
        )
        try await upstreamApp.test(.live) { upstreamClient in
            let origin = "http://localhost:\(try XCTUnwrap(upstreamClient.port))"
            try await self.withBridge(
                secretDomains: secretDomains,
                maxRequestBodyBytes: maxRequestBodyBytes
            ) { bridge, client, activity in
                try await body(Harness(origin: origin, bridge: bridge, client: client, seen: seen, activity: activity))
            }
        }
    }

    private func withBridge(
        secretDomains: [String] = ["localhost"],
        maxRequestBodyBytes: Int? = nil,
        _ body: (String, HTTPClient, AgentActivityTracker) async throws -> Void
    ) async throws {
        let injector = SecretInjector(secrets: [
            .init(name: "GITHUB_TOKEN", realValue: Self.token, maskedValue: Self.masked, domains: secretDomains)
        ])
        let activity = AgentActivityTracker()
        let defaultClient = HTTPClient(eventLoopGroupProvider: .singleton)
        let rawClient = RawFetchProxy.makeHTTPClient()
        let client = HTTPClient(eventLoopGroupProvider: .singleton)
        let router = Router()
        registerAPIRoutes(
            router: router,
            lickSystem: LickSystem(),
            config: .forTests(),
            httpClient: defaultClient,
            agentActivityTracker: activity,
            secretInjector: injector,
            rawFetchHTTPClient: rawClient
        )
        if let maxRequestBodyBytes {
            // Shrunk cap: mount a second raw route ahead of the real one.
            let raw = RawFetchProxy(
                httpClient: rawClient,
                secretInjector: injector,
                activityTracker: activity,
                maxRequestBodyBytes: maxRequestBodyBytes
            )
            router.post("/api/raw-capped") { request, _ in
                try await raw.respond(to: request) ?? Response(status: .notFound)
            }
        }
        let bridgeApp = Application(
            responder: router.buildResponder()
        )
        do {
            try await bridgeApp.test(.live) { bridgeClient in
                let port = try XCTUnwrap(bridgeClient.port)
                let path = maxRequestBodyBytes == nil ? "/api/fetch-proxy" : "/api/raw-capped"
                try await body("http://localhost:\(port)\(path)", client, activity)
            }
        } catch {
            try? await client.shutdown()
            try? await rawClient.shutdown()
            try? await defaultClient.shutdown()
            throw error
        }
        try await client.shutdown()
        try await rawClient.shutdown()
        try await defaultClient.shutdown()
    }

    private func encodeHead(url: String, method: String, headers: [(String, String)]) throws -> String {
        let object: [String: Any] = ["url": url, "method": method, "headers": headers.map { [$0.0, $0.1] }]
        return utf8Text(try JSONSerialization.data(withJSONObject: object))
    }

    private func rawRequest(
        _ h: Harness,
        url: String,
        method: String = "GET",
        headers: [(String, String)] = []
    ) throws -> HTTPClientRequest {
        var request = HTTPClientRequest(url: h.bridge)
        request.method = .POST
        request.headers.add(name: RawFetchProtocol.requestHeader, value: try encodeHead(url: url, method: method, headers: headers))
        request.headers.add(name: "Content-Type", value: "application/octet-stream")
        return request
    }

    private func rawFetch(
        _ h: Harness,
        url: String,
        method: String = "GET",
        headers: [(String, String)] = [],
        body: [UInt8]? = nil
    ) async throws -> RawResult {
        var request = try rawRequest(h, url: url, method: method, headers: headers)
        if let body { request.body = .bytes(ByteBuffer(bytes: body)) }
        return try await read(h.client.execute(request, timeout: .seconds(30)))
    }

    private func read(_ response: HTTPClientResponse) async throws -> RawResult {
        let bytes = Array(try await response.body.collect(upTo: 64 * 1024 * 1024).readableBytesView)
        if response.headers.first(name: "x-proxy-error") == "1" {
            throw ProxyError(status: Int(response.status.code), message: utf8Text(bytes))
        }
        let (head, rest) = try XCTUnwrap(Self.decodeFrame(bytes))
        return RawResult(
            status: Int(response.status.code),
            contentType: response.headers.first(name: "content-type"),
            head: head,
            body: rest
        )
    }

    private func values(_ headers: RawHeaderList, _ name: String) -> [String] {
        headers.filter { $0.name.lowercased() == name }.map(\.value)
    }

    private func assertStatus(
        _ expected: Int,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("expected a \(expected) proxy error", file: file, line: line)
        } catch let error as ProxyError {
            XCTAssertEqual(error.status, expected, error.message, file: file, line: line)
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }

    // MARK: - Tests

    func testHandsThe3xxLocationAndEverySetCookieToTheCaller() async throws {
        try await withHarness(
            upstream: Upstream { seen in
                if seen.path == "/next" { return Self.respond(.ok, [], Array("followed".utf8)) }
                return Self.respond(
                    .init(code: 302, reasonPhrase: "Found"),
                    [
                        ("Location", "/next"), ("Set-Cookie", "a=1; Path=/"), ("Set-Cookie", "b=2; HttpOnly"),
                        ("Link", "</x>; rel=preload"), ("Link", "</y>; rel=preload"),
                    ],
                    Array("moved".utf8)
                )
            }
        ) { h in
            let result = try await rawFetch(h, url: "\(h.origin)/start")
            XCTAssertEqual(result.status, 200)
            XCTAssertEqual(result.contentType, RawFetchProtocol.contentType)
            XCTAssertEqual(result.head.status, 302)
            XCTAssertEqual(result.head.statusText, "Found")
            XCTAssertEqual(result.head.url, "\(h.origin)/start")
            XCTAssertEqual(values(result.head.headers, "location"), ["/next"])
            XCTAssertEqual(values(result.head.headers, "set-cookie"), ["a=1; Path=/", "b=2; HttpOnly"])
            // Unlike node-server (whose fetch folds them), repeats stay separate.
            XCTAssertEqual(values(result.head.headers, "link"), ["</x>; rel=preload", "</y>; rel=preload"])
            XCTAssertEqual(utf8Text(result.body), "moved")
            let paths = await h.seen.requests.map(\.path)
            XCTAssertEqual(paths, ["/start"])
            let active = await h.activity.isActiveInLastMinute()
            XCTAssertTrue(active)
        }
    }

    func testTheDefaultRouteStillFollowsRedirects() async throws {
        try await withHarness(
            upstream: Upstream { seen in
                seen.path == "/next"
                    ? Self.respond(.ok, [], Array("followed".utf8))
                    : Self.respond(.found, [("Location", "/next")])
            }
        ) { h in
            var request = HTTPClientRequest(url: h.bridge)
            request.headers.add(name: "X-Target-URL", value: "\(h.origin)/start")
            let response = try await h.client.execute(request, timeout: .seconds(30))
            XCTAssertEqual(response.status, .ok)
            let text = String(buffer: try await response.body.collect(upTo: 1024))
            XCTAssertEqual(text, "followed")
        }
    }

    func testSendsTheCallerMethodHeadersAndBinaryBody() async throws {
        let body: [UInt8] = [0, 0xff, 0xd8, 0x80, 0x0a]
        try await withHarness(upstream: Upstream { _ in Self.respond(.created) }) { h in
            let result = try await rawFetch(
                h,
                url: "\(h.origin)/upload",
                method: "PROPFIND",
                headers: [
                    ("User-Agent", "curl/8.22.0"), ("Cookie", "a=1"), ("Cookie", "b=2"),
                    ("Accept-Encoding", "zstd"), ("Connection", "X-Hop"), ("X-Hop", "drop me"),
                    ("Content-Type", "application/octet-stream"),
                ],
                body: body
            )
            XCTAssertEqual(result.head.status, 201)
            XCTAssertEqual(result.body, [])
            let first = await h.seen.requests.first
            let seen = try XCTUnwrap(first)
            XCTAssertEqual(seen.method, "PROPFIND")
            XCTAssertEqual(seen.headers[.userAgent], "curl/8.22.0")
            XCTAssertEqual(seen.headers[.cookie], "a=1; b=2")
            XCTAssertEqual(seen.headers[.acceptEncoding], "gzip, deflate")
            XCTAssertNil(seen.headers[HTTPField.Name("X-Hop")!])
            XCTAssertNil(seen.headers[HTTPField.Name(RawFetchProtocol.requestHeader)!])
            XCTAssertNil(seen.headers[.origin])
            XCTAssertEqual(seen.body, body)
        }
    }

    func testDeliversAGzipBodyDecodedWithoutEncodingOrLength() async throws {
        let text = String(repeating: "hello raw mode\n", count: 100)
        let gz = try gzipForTest(Array(text.utf8))
        try await withHarness(
            upstream: Upstream { _ in
                Self.respond(
                    .ok,
                    [("Content-Type", "text/plain"), ("Content-Encoding", "gzip"), ("Content-Length", "\(gz.count)")],
                    gz
                )
            }
        ) { h in
            let result = try await rawFetch(h, url: "\(h.origin)/gz")
            XCTAssertEqual(utf8Text(result.body), text)
            XCTAssertEqual(values(result.head.headers, "content-encoding"), [])
            XCTAssertEqual(values(result.head.headers, "content-length"), [])
        }
    }

    func testInflatesUndeclaredGzipTextAfterTheHeadFrame() async throws {
        let text = "export const aem = 1;\n"
        let gz = try gzipForTest(Array(text.utf8))
        try await withHarness(
            upstream: Upstream { _ in
                Self.respond(.ok, [("Content-Type", "application/javascript"), ("Content-Length", "\(gz.count)")], gz)
            }
        ) { h in
            let result = try await rawFetch(h, url: "\(h.origin)/cached.js")
            XCTAssertEqual(utf8Text(result.body), text)
            XCTAssertEqual(values(result.head.headers, "content-length"), [])
        }
    }

    func testKeepsContentLengthOnAnIdentityBinaryBody() async throws {
        let bytes = (0..<70_000).map { UInt8(($0 * 7) % 256) }
        try await withHarness(
            upstream: Upstream { _ in
                Self.respond(.ok, [("Content-Type", "application/octet-stream"), ("Content-Length", "\(bytes.count)")], bytes)
            }
        ) { h in
            let result = try await rawFetch(h, url: "\(h.origin)/bin")
            XCTAssertEqual(values(result.head.headers, "content-length"), ["\(bytes.count)"])
            XCTAssertEqual(result.body, bytes)
        }
    }

    /// An origin that serves a range over gzip whenever the request allows gzip.
    private static func rangeOrigin(whole: [UInt8], alwaysGzip: Bool = false) -> Upstream {
        Upstream { seen in
            let range = seen.headers[.range] ?? ""
            let bounds = range.dropFirst("bytes=".count).split(separator: "-").compactMap { Int($0) }
            let gzip = alwaysGzip || (seen.headers[.acceptEncoding] ?? "").contains("gzip")
            let representation = gzip ? try gzipForTest(whole) : whole
            let slice = Array(representation[bounds[0]...bounds[1]])
            var headers = [
                ("Content-Type", "application/octet-stream"),
                ("Content-Range", "bytes \(bounds[0])-\(bounds[1])/\(representation.count)"),
                ("Content-Length", "\(slice.count)"),
            ]
            if gzip { headers.append(("Content-Encoding", "gzip")) }
            return respond(.partialContent, headers, slice)
        }
    }

    private static let whole = Array(String(repeating: "0123456789abcdefghij", count: 50).utf8)

    func testARangedRequestAsksForIdentitySoThe206MatchesItsContentRange() async throws {
        try await withHarness(upstream: Self.rangeOrigin(whole: Self.whole)) { h in
            let result = try await rawFetch(
                h,
                url: "\(h.origin)/file",
                headers: [("Range", "bytes=10-29"), ("Accept-Encoding", "gzip")]
            )
            let seen = await h.seen.requests.first
            XCTAssertEqual(seen?.headers[.acceptEncoding], "identity")
            XCTAssertEqual(result.head.status, 206)
            XCTAssertEqual(values(result.head.headers, "content-range"), ["bytes 10-29/\(Self.whole.count)"])
            XCTAssertEqual(values(result.head.headers, "content-encoding"), [])
            XCTAssertEqual(result.body, Array(Self.whole[10..<30]))
        }
    }

    func testRefusesA206TheOriginEncodedAnyway() async throws {
        try await withHarness(upstream: Self.rangeOrigin(whole: Self.whole, alwaysGzip: true)) { h in
            await assertStatus(502) {
                _ = try await rawFetch(h, url: "\(h.origin)/file", headers: [("Range", "bytes=0-9")])
            }
        }
    }

    func testRefusesACodingStackTheClientOnlyHalfUndid() async throws {
        let gz = try gzipForTest(Array("layered".utf8))
        try await withHarness(
            upstream: Upstream { _ in
                Self.respond(.ok, [("Content-Type", "application/octet-stream"), ("Content-Encoding", "gzip, br")], gz)
            }
        ) { h in
            await assertStatus(502) { _ = try await rawFetch(h, url: "\(h.origin)/stacked") }
        }
    }

    func testKeepsAnEncodingTheClientDoesNotUndo() async throws {
        let bytes: [UInt8] = [0x0b, 0x02, 0x80, 0x68, 0x69, 0x03]
        try await withHarness(
            upstream: Upstream { _ in
                Self.respond(
                    .ok,
                    [("Content-Type", "application/octet-stream"), ("Content-Encoding", "br"), ("Content-Length", "6")],
                    bytes
                )
            }
        ) { h in
            let result = try await rawFetch(h, url: "\(h.origin)/br")
            XCTAssertEqual(values(result.head.headers, "content-encoding"), ["br"])
            XCTAssertEqual(values(result.head.headers, "content-length"), ["6"])
            XCTAssertEqual(result.body, bytes)
        }
    }

    func testKeepsCompressionForWholeBodyRequests() async throws {
        try await withHarness(upstream: Upstream { _ in Self.respond(.ok, [], Array("ok".utf8)) }) { h in
            _ = try await rawFetch(h, url: "\(h.origin)/whole")
            let seen = await h.seen.requests.first
            XCTAssertEqual(seen?.headers[.acceptEncoding], "gzip, deflate")
        }
    }

    func testKeepsTheRepresentationHeadersOfAHeadResponse() async throws {
        try await withHarness(
            upstream: Upstream { _ in
                Self.respond(.ok, [("Content-Encoding", "gzip"), ("Content-Length", "1234")])
            }
        ) { h in
            let result = try await rawFetch(h, url: "\(h.origin)/head", method: "HEAD")
            XCTAssertEqual(values(result.head.headers, "content-encoding"), ["gzip"])
            XCTAssertEqual(values(result.head.headers, "content-length"), ["1234"])
            XCTAssertEqual(result.body, [])
        }
    }

    func testUnmasksAnAllowedSecretAndScrubsItFromLocationAndTheBody() async throws {
        try await withHarness(
            upstream: Upstream { seen in
                Self.respond(
                    .found,
                    [("Location", "/cb?token=\(Self.token)"), ("Content-Type", "text/plain")],
                    Array("echo \(seen.headers[.authorization] ?? "")".utf8)
                )
            }
        ) { h in
            let result = try await rawFetch(
                h,
                url: "\(h.origin)/auth",
                headers: [("Authorization", "Bearer \(Self.masked)")]
            )
            let seen = await h.seen.requests.first
            XCTAssertEqual(seen?.headers[.authorization], "Bearer \(Self.token)")
            XCTAssertEqual(values(result.head.headers, "location"), ["/cb?token=\(Self.masked)"])
            XCTAssertEqual(utf8Text(result.body), "echo Bearer \(Self.masked)")
        }
    }

    func testUnmasksUrlCredentialsIntoASyntheticAuthorization() async throws {
        try await withHarness(upstream: Upstream { _ in Self.respond(.ok) }) { h in
            let url = h.origin.replacingOccurrences(of: "http://", with: "http://x-access-token:\(Self.masked)@")
            _ = try await rawFetch(h, url: "\(url)/repo.git/info/refs")
            let seen = await h.seen.requests.first
            let expected = Data("x-access-token:\(Self.token)".utf8).base64EncodedString()
            XCTAssertEqual(seen?.headers[.authorization], "Basic \(expected)")
        }
    }

    func testSignsTheBodyForHmacSignAndNeverForwardsTheDirective() async throws {
        try await withHarness(upstream: Upstream { _ in Self.respond(.ok, [], Array("ok".utf8)) }) { h in
            _ = try await rawFetch(
                h,
                url: "\(h.origin)/hook",
                method: "POST",
                headers: [("Content-Type", "application/json"), ("X-Slicc-Hmac-Sign", "GITHUB_TOKEN:x-signature")],
                body: Array(#"{"a":1}"#.utf8)
            )
            let first = await h.seen.requests.first
            let seen = try XCTUnwrap(first)
            XCTAssertEqual(seen.headers[HTTPField.Name("x-signature")!], Self.hmacHex(key: Self.token, body: #"{"a":1}"#))
            XCTAssertNil(seen.headers[HTTPField.Name("x-slicc-hmac-sign")!])
            XCTAssertEqual(utf8Text(seen.body), #"{"a":1}"#)
        }
    }

    func testRefusesASecretOnADomainItIsNotScopedTo() async throws {
        try await withHarness(
            secretDomains: ["api.github.com"],
            upstream: Upstream { _ in Self.respond(.ok) }
        ) { h in
            await assertStatus(403) {
                _ = try await rawFetch(h, url: "\(h.origin)/steal", headers: [("Authorization", "Bearer \(Self.masked)")])
            }
            let count = await h.seen.requests.count
            XCTAssertEqual(count, 0)
        }
    }

    func testAnswers413PastTheRequestBodyLimitWithoutContactingUpstream() async throws {
        try await withHarness(maxRequestBodyBytes: 8, upstream: Upstream { _ in Self.respond(.ok) }) { h in
            await assertStatus(413) {
                _ = try await rawFetch(h, url: "\(h.origin)/big", method: "PUT", body: [UInt8](repeating: 0, count: 9))
            }
            let count = await h.seen.requests.count
            XCTAssertEqual(count, 0)
        }
    }

    func testAnswersTheCapabilityProbeWithoutContactingUpstream() async throws {
        try await withHarness(upstream: Upstream { _ in Self.respond(.ok) }) { h in
            var request = HTTPClientRequest(url: h.bridge)
            request.method = .POST
            request.headers.add(name: RawFetchProtocol.probeHeader, value: "1")
            let response = try await h.client.execute(request, timeout: .seconds(30))
            XCTAssertEqual(response.status, .ok)
            let body = try await response.body.collect(upTo: 1024)
            let reply = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(buffer: body)) as? [String: Any])
            XCTAssertEqual(reply["rawFetch"] as? Int, 1)
            XCTAssertEqual(reply["requestBodyStreaming"] as? Bool, true)
            XCTAssertEqual(reply["maxRequestBodyBytes"] as? Int, 256 * 1024 * 1024)
            let count = await h.seen.requests.count
            XCTAssertEqual(count, 0)
            let active = await h.activity.isActiveInLastMinute()
            XCTAssertFalse(active)
        }
    }

    func testDropsUpstreamFieldsNamedByConnection() async throws {
        try await withHarness(
            upstream: Upstream { _ in
                Self.respond(.ok, [("Connection", "X-Hop"), ("X-Hop", "hop-local"), ("X-End", "kept")])
            }
        ) { h in
            let result = try await rawFetch(h, url: "\(h.origin)/hop")
            XCTAssertEqual(values(result.head.headers, "x-hop"), [])
            XCTAssertEqual(values(result.head.headers, "x-end"), ["kept"])
        }
    }

    func testRejectsAMalformedHeadAndAnUnreachableUpstream() async throws {
        try await withHarness(upstream: Upstream { _ in Self.respond(.ok) }) { h in
            var request = HTTPClientRequest(url: h.bridge)
            request.method = .POST
            request.headers.add(name: RawFetchProtocol.requestHeader, value: #"{"url":1}"#)
            let malformed = try await h.client.execute(request, timeout: .seconds(30))
            XCTAssertEqual(malformed.status, .badRequest)
            XCTAssertEqual(malformed.headers.first(name: "x-proxy-error"), "1")
            _ = try await malformed.body.collect(upTo: 1024)
            await assertStatus(502) { _ = try await rawFetch(h, url: "http://127.0.0.1:1/unreachable") }
        }
    }

    /// A refusal answered before the upload is read must not leave that
    /// upload on a kept-alive connection, or the next request on it parses
    /// the leftover bytes as its request line. The live test client keeps
    /// one connection, so the probe below rides the refused request's.
    func testARefusalBeforeTheUploadIsReadKeepsTheConnectionUsable() async throws {
        let injector = SecretInjector(secrets: [
            .init(name: "GITHUB_TOKEN", realValue: Self.token, maskedValue: Self.masked, domains: ["api.github.com"])
        ])
        let rawClient = RawFetchProxy.makeHTTPClient()
        let defaultClient = HTTPClient(eventLoopGroupProvider: .singleton)
        let router = Router()
        registerAPIRoutes(
            router: router,
            lickSystem: LickSystem(),
            config: .forTests(),
            httpClient: defaultClient,
            secretInjector: injector,
            rawFetchHTTPClient: rawClient
        )
        let refusals: [(String, HTTPResponse.Status)] = [
            (#"{"url":"https://evil.test/","method":"POST","headers":[["Authorization","Bearer \#(Self.masked)"]]}"#, .forbidden),
            (#"{"url":"https://e.test/","method":"POST","headers":[["bad name","x"]]}"#, .badRequest),
            (#"{"url":1}"#, .badRequest),
        ]
        do {
            try await Application(responder: router.buildResponder()).test(.live) { client in
                for (head, status) in refusals {
                    let body = ByteBuffer(string: "GET /api/agent-activity HTTP/1.1\r\nHost: x\r\n\r\n")
                    try await client.execute(
                        uri: "/api/fetch-proxy",
                        method: .post,
                        headers: [HTTPField.Name(RawFetchProtocol.requestHeader)!: head, .contentType: "text/plain"],
                        body: body
                    ) { response in
                        XCTAssertEqual(response.status, status, head)
                    }
                    try await client.execute(
                        uri: "/api/fetch-proxy",
                        method: .post,
                        headers: [HTTPField.Name(RawFetchProtocol.probeHeader)!: "1"]
                    ) { response in
                        XCTAssertEqual(response.status, .ok, "request after \(head)")
                        XCTAssertTrue(String(buffer: response.body).contains("rawFetch"), "request after \(head)")
                    }
                }
            }
        } catch {
            try? await rawClient.shutdown()
            try? await defaultClient.shutdown()
            throw error
        }
        try await rawClient.shutdown()
        try await defaultClient.shutdown()
    }

    // MARK: - Streaming

    private final class Gate: @unchecked Sendable {
        private let stream: AsyncStream<Void>
        private let continuation: AsyncStream<Void>.Continuation

        init() {
            (stream, continuation) = AsyncStream.makeStream()
        }

        func open() { continuation.finish() }
        func wait() async { for await _ in stream {} }
    }

    func testStreamsASlowBodyChunkByChunk() async throws {
        let gate = Gate()
        try await withHarness(
            upstream: Upstream { _ in
                Response(
                    status: .ok,
                    headers: [.contentType: "application/octet-stream"],
                    body: ResponseBody { writer in
                        try await writer.write(ByteBuffer(string: "first"))
                        await gate.wait()
                        try await writer.write(ByteBuffer(string: "second"))
                        try await writer.finish(nil)
                    }
                )
            }
        ) { h in
            let request = try rawRequest(h, url: "\(h.origin)/slow")
            let response = try await h.client.execute(request, timeout: .seconds(30))
            var iterator = response.body.makeAsyncIterator()
            var buffered: [UInt8] = []
            var split: (RawFetchResponseHead, [UInt8])?
            while split.map({ utf8Text($0.1) }) != "first" {
                let next = try await iterator.next()
                let chunk = try XCTUnwrap(next)
                buffered += chunk.readableBytesView
                split = Self.decodeFrame(buffered)
            }
            XCTAssertEqual(split?.0.status, 200)
            gate.open()
            var tail = ""
            while let chunk = try await iterator.next() { tail += String(buffer: chunk) }
            XCTAssertEqual(tail, "second")
        }
    }

    /// A chunked request body: `first`, then the rest once `gate` opens.
    private struct GatedBody: AsyncSequence, Sendable {
        typealias Element = ByteBuffer
        let chunks: [[UInt8]]
        let gate: Gate?

        struct AsyncIterator: AsyncIteratorProtocol {
            var index = 0
            let chunks: [[UInt8]]
            let gate: Gate?

            mutating func next() async -> ByteBuffer? {
                guard index < chunks.count else { return nil }
                if index == 1 { await gate?.wait() }
                defer { index += 1 }
                return ByteBuffer(bytes: chunks[index])
            }
        }

        func makeAsyncIterator() -> AsyncIterator { AsyncIterator(chunks: chunks, gate: gate) }
    }

    func testForwardsAStreamedBinaryUploadAsItArrivesPastTheBufferCap() async throws {
        let firstBytes = Gate()
        let upstreamApp = Application(
            responder: CallbackResponder<BasicRequestContext> { request, _ in
                var received: [UInt8] = []
                for try await chunk in request.body {
                    received += chunk.readableBytesView
                    firstBytes.open()
                }
                let summary = "\(request.headers[.contentLength] ?? "-") \(request.headers[HTTPField.Name("Transfer-Encoding")!] ?? "-") \(received)"
                return Response(status: .ok, body: .init(byteBuffer: ByteBuffer(string: summary)))
            }
        )
        try await upstreamApp.test(.live) { upstreamClient in
            let origin = "http://localhost:\(try XCTUnwrap(upstreamClient.port))"
            try await withHarness(maxRequestBodyBytes: 4, upstream: Upstream { _ in Self.respond(.ok) }) { h in
                var request = try rawRequest(
                    h,
                    url: "\(origin)/objects",
                    method: "POST",
                    headers: [("Content-Type", "application/octet-stream"), ("Content-Length", "6")]
                )
                request.body = .stream(GatedBody(chunks: [[1, 2, 3], [4, 5, 6]], gate: firstBytes), length: .unknown)
                let result = try await read(h.client.execute(request, timeout: .seconds(30)))
                XCTAssertEqual(result.head.status, 200)
                XCTAssertEqual(utf8Text(result.body), "6 - [1, 2, 3, 4, 5, 6]")
            }
        }
    }

    func testStillBuffersAndUnmasksATextBodyThatArrivesChunked() async throws {
        try await withHarness(upstream: Upstream { _ in Self.respond(.ok, [], Array("ok".utf8)) }) { h in
            let text = Array(#"{"token":"\#(Self.masked)"}"#.utf8)
            var request = try rawRequest(
                h,
                url: "\(h.origin)/json",
                method: "POST",
                headers: [("Content-Type", "application/json")]
            )
            request.body = .stream(GatedBody(chunks: [Array(text[..<5]), Array(text[5...])], gate: nil), length: .unknown)
            _ = try await read(h.client.execute(request, timeout: .seconds(30)))
            let first = await h.seen.requests.first
            let seen = try XCTUnwrap(first)
            XCTAssertEqual(utf8Text(seen.body), #"{"token":"\#(Self.token)"}"#)
            XCTAssertEqual(seen.headers[.contentLength], "\(seen.body.count)")
        }
    }
}

extension RawFetchProxyTests {
    /// The webapp's `decodeRawResponseFrame`, for reading answers back.
    fileprivate static func decodeFrame(_ bytes: [UInt8]) -> (RawFetchResponseHead, [UInt8])? {
        guard bytes.count >= 4 else { return nil }
        let length = bytes[0..<4].reduce(0) { $0 << 8 | Int($1) }
        guard bytes.count >= 4 + length,
            let object = try? JSONSerialization.jsonObject(with: Data(bytes[4..<4 + length])) as? [String: Any],
            let status = object["status"] as? Int,
            let statusText = object["statusText"] as? String,
            let url = object["url"] as? String,
            let pairs = object["headers"] as? [[String]]
        else { return nil }
        let head = RawFetchResponseHead(
            status: status,
            statusText: statusText,
            headers: pairs.map { RawHeaderPair($0[0], $0[1]) },
            url: url
        )
        return (head, Array(bytes[(4 + length)...]))
    }

    fileprivate static func fields(_ pairs: [(String, String)]) -> HTTPFields {
        var fields = HTTPFields()
        for (name, value) in pairs { fields.append(HTTPField(name: HTTPField.Name(name)!, value: value)) }
        return fields
    }

    fileprivate static func respond(
        _ status: HTTPResponse.Status,
        _ headers: [(String, String)] = [],
        _ body: [UInt8] = []
    ) -> Response {
        Response(status: status, headers: fields(headers), body: .init(byteBuffer: ByteBuffer(bytes: body)))
    }

    fileprivate static func hmacHex(key: String, body: String) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        let keyBytes = Array(key.utf8)
        let bodyBytes = Array(body.utf8)
        CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), keyBytes, keyBytes.count, bodyBytes, bodyBytes.count, &digest)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Bytes as UTF-8 text, for assertions.
private func utf8Text<Bytes: Sequence>(_ bytes: Bytes) -> String where Bytes.Element == UInt8 {
    String(bytes: Array(bytes), encoding: .utf8) ?? "<not UTF-8>"
}

extension ServerConfig {
    /// A plain CLI configuration for route tests.
    static func forTests() -> ServerConfig {
        .init(
            serveOnly: false, cdpPort: 9222, explicitCdpPort: false, electron: false, electronApp: nil,
            electronAppURL: nil, kill: false, lead: false, leadWorkerBaseUrl: nil, leadWorkerBaseURL: nil,
            profile: nil, join: false, joinUrl: nil, joinURL: nil, logLevel: "info", logDir: nil,
            logDirectoryURL: nil, prompt: nil, envFile: nil, envFileURL: nil, mounts: []
        )
    }
}
