import AsyncHTTPClient
import Foundation
import Hummingbird
import HummingbirdTesting
import HTTPTypes
import NIOCore
import NIOPosix
import XCTest
@testable import slicc_server

final class APIRoutesTests: XCTestCase {
    func testStatusNamesTheNativeServer() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/status", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertEqual(response.headers[HTTPField.Name("Cache-Control")!], "no-store")
                    let body = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(body["status"], .string("ok"))
                    // The UI fingerprints the serving runtime from this field
                    // ("sliccstart" floatbar label) — keep it stable.
                    XCTAssertEqual(body["service"], .string("slicc-server"))
                    if case .string(let timestamp)? = body["timestamp"] {
                        XCTAssertFalse(timestamp.isEmpty)
                    } else {
                        XCTFail("timestamp missing from /api/status body")
                    }
                }
            }
        }
    }

    func testRuntimeConfigReturnsConfiguredValues() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(
                    leadWorkerBaseUrl: "https://worker.example",
                    joinUrl: "https://join.example/session"
                ),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/runtime-config", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertEqual(
                        try self.decodeJSONObject(from: response.body),
                        [
                            "trayWorkerBaseUrl": .string("https://worker.example"),
                            "trayJoinUrl": .string("https://join.example/session"),
                        ]
                    )
                }
            }
        }
    }

    func testRuntimeConfigDefaultsToProductionUrlWhenNotDev() async throws {
        let savedEnv = ProcessInfo.processInfo.environment["WORKER_BASE_URL"]
        unsetenv("WORKER_BASE_URL")
        defer {
            if let savedEnv {
                setenv("WORKER_BASE_URL", savedEnv, 1)
            } else {
                unsetenv("WORKER_BASE_URL")
            }
        }

        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(dev: false),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/runtime-config", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    let body = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(body["trayWorkerBaseUrl"], .string("https://www.sliccy.ai"))
                    XCTAssertEqual(body["trayJoinUrl"], .null)
                }
            }
        }
    }

    func testRuntimeConfigReturnsNullUrlInDevMode() async throws {
        let savedEnv = ProcessInfo.processInfo.environment["WORKER_BASE_URL"]
        unsetenv("WORKER_BASE_URL")
        defer {
            if let savedEnv {
                setenv("WORKER_BASE_URL", savedEnv, 1)
            } else {
                unsetenv("WORKER_BASE_URL")
            }
        }

        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(dev: true),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/runtime-config", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    let body = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(body["trayWorkerBaseUrl"], .null)
                    XCTAssertEqual(body["trayJoinUrl"], .null)
                }
            }
        }
    }

    func testTrayStatusForwardsBrowserResponse() async throws {
        try await self.withHTTPClient { httpClient in
            let lickSystem = LickSystem()
            await self.attachResponderClient(to: lickSystem) { request in
                XCTAssertEqual(request["type"], .string("tray_status"))
                return .object(["leader": .bool(true)])
            }

            let router = Router()
            registerAPIRoutes(router: router, lickSystem: lickSystem, config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/tray-status", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertEqual(try self.decodeJSONObject(from: response.body), ["leader": .bool(true)])
                }
            }
        }
    }

    func testTrayStatusReturnsServiceUnavailableWithoutBrowser() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/tray-status", method: .get) { response in
                    XCTAssertEqual(response.status, .serviceUnavailable)
                    XCTAssertEqual(try self.decodeJSONObject(from: response.body)["error"], .string("No browser connected"))
                }
            }
        }
    }

    func testFetchProxyMissingTargetURLIsTaggedAsProxyError() async throws {
        // The proxy must mark its own infrastructure errors with X-Proxy-Error: 1
        // so SecureFetch clients can distinguish them from upstream 4xx/5xx
        // responses (which must flow through unchanged so curl prints the
        // body instead of the previous "[object Object]").
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/fetch-proxy", method: .post) { response in
                    XCTAssertEqual(response.status, .badRequest)
                    XCTAssertEqual(response.headers[HTTPField.Name("X-Proxy-Error")!], "1")
                    XCTAssertEqual(
                        try self.decodeJSONObject(from: response.body)["error"],
                        .string("Missing X-Target-URL header")
                    )
                }
            }
        }
    }

    func testFetchProxyUpstreamFailureIsTaggedAsProxyError() async throws {
        // Pointing the proxy at an unreachable upstream forces the underlying
        // fetch to throw, which the proxy converts to a 502 — that 502 IS a
        // proxy infrastructure failure and so must carry the marker.
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/fetch-proxy",
                    method: .get,
                    headers: [HTTPField.Name("X-Target-URL")!: "http://127.0.0.1:1/never"]
                ) { response in
                    XCTAssertEqual(response.status, .badGateway)
                    XCTAssertEqual(response.headers[HTTPField.Name("X-Proxy-Error")!], "1")
                }
            }
        }
    }

    // The fetch proxy must accept WebDAV (RFC 4918) and CalDAV (RFC 4791)
    // verbs in addition to the standard HTTP methods so the agent can
    // talk to CalDAV / WebDAV servers from the Sliccstart float. The four
    // round-trip tests below cover the new method set end-to-end against
    // the representative verbs called out in the spec's Acceptance
    // Criterion #3 (PROPFIND, REPORT, MKCALENDAR, LOCK): the proxy must
    // register the route, forward the verb / body / DAV-specific request
    // header unchanged, and let the upstream's response flow back to the
    // client. The remaining five verbs (PROPPATCH, MKCOL, COPY, MOVE,
    // UNLOCK) share the exact same code path.

    func testFetchProxyForwardsPropfindWithBodyAndDavHeaders() async throws {
        try await self.runDavRoundTripTest(
            method: "PROPFIND",
            davHeaderName: "Depth",
            davHeaderValue: "1",
            requestBody: """
                <?xml version="1.0" encoding="utf-8"?>
                <D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>
                """
        )
    }

    func testFetchProxyForwardsReportWithCalDAVBody() async throws {
        try await self.runDavRoundTripTest(
            method: "REPORT",
            davHeaderName: "Depth",
            davHeaderValue: "1",
            requestBody: """
                <?xml version="1.0" encoding="utf-8"?>
                <C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
                  <D:prop><D:getetag/><C:calendar-data/></D:prop>
                  <C:filter><C:comp-filter name="VCALENDAR"/></C:filter>
                </C:calendar-query>
                """
        )
    }

    func testFetchProxyForwardsMkcalendarWithoutBody() async throws {
        // MKCALENDAR (RFC 4791 § 5.3.1) is the CalDAV verb for creating a
        // calendar collection; the request body is optional and frequently
        // omitted. This test exercises the no-body path and asserts the
        // verb passes through to the upstream and the upstream's response
        // status flows back unchanged.
        try await self.runDavRoundTripTest(
            method: "MKCALENDAR",
            davHeaderName: nil,
            davHeaderValue: nil,
            requestBody: ""
        )
    }

    func testFetchProxyForwardsLockWithBodyAndTimeoutHeader() async throws {
        // LOCK (RFC 4918 § 9.10) carries both an XML body (lockinfo) and
        // the WebDAV-specific `Timeout` request header. This test asserts
        // that the verb, body, and `Timeout: Second-300` header all reach
        // the upstream unchanged.
        try await self.runDavRoundTripTest(
            method: "LOCK",
            davHeaderName: "Timeout",
            davHeaderValue: "Second-300",
            requestBody: """
                <?xml version="1.0" encoding="utf-8"?>
                <D:lockinfo xmlns:D="DAV:">
                  <D:lockscope><D:exclusive/></D:lockscope>
                  <D:locktype><D:write/></D:locktype>
                  <D:owner><D:href>mailto:agent@example.com</D:href></D:owner>
                </D:lockinfo>
                """
        )
    }

    // Wave 13b parity with node-server's forwardUpstreamHeaders strip:
    // the proxy route itself must NOT forward upstream `Access-Control-*`
    // headers. The thin-bridge CORS layer
    // (ThinBridgeCorsMiddleware/BridgeSecurity) owns the entire CORS
    // contract, so testing the route in `.router` mode (without the
    // middleware) directly asserts the defense-in-depth contract.
    func testFetchProxyStripsUpstreamAccessControlHeaders() async throws {
        // Build an upstream stub that pretends to be a hostile origin
        // returning a wide-open `Access-Control-Allow-Origin: *`-style
        // header plus `Access-Control-Allow-Credentials` and a preflight-
        // only header that the bridge middleware doesn't overwrite.
        let upstreamRouter = Router()
        upstreamRouter.get("/upstream") { _, _ in
            Response(
                status: .ok,
                headers: [
                    .contentType: "text/plain; charset=utf-8",
                    HTTPField.Name("Access-Control-Allow-Origin")!: "https://evil.example",
                    HTTPField.Name("Access-Control-Allow-Credentials")!: "true",
                    HTTPField.Name("Access-Control-Expose-Headers")!: "X-Evil",
                    HTTPField.Name("Access-Control-Max-Age")!: "86400",
                ],
                body: .init(byteBuffer: ByteBuffer(string: "body"))
            )
        }
        let upstreamApp = Application(responder: upstreamRouter.buildResponder())

        // Dedicated MTELG-backed HTTPClient — see `runDavRoundTripTest`
        // for the `NWPOSIXError 1` rationale.
        let eventLoopGroup = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        let httpClient = HTTPClient(eventLoopGroupProvider: .shared(eventLoopGroup))

        do {
            try await upstreamApp.test(.live) { upstreamClient in
                let upstreamPort = try XCTUnwrap(upstreamClient.port, "live test framework must expose a port")
                let proxyRouter = Router()
                registerAPIRoutes(
                    router: proxyRouter,
                    lickSystem: LickSystem(),
                    config: self.makeConfig(),
                    httpClient: httpClient
                )
                let proxyApp = Application(responder: proxyRouter.buildResponder())

                try await proxyApp.test(.router) { proxyClient in
                    try await proxyClient.execute(
                        uri: "/api/fetch-proxy",
                        method: .get,
                        headers: [
                            HTTPField.Name("X-Target-URL")!: "http://localhost:\(upstreamPort)/upstream",
                        ]
                    ) { response in
                        XCTAssertEqual(response.status, .ok, "upstream 200 must flow back to the client")
                        XCTAssertEqual(String(buffer: response.body), "body", "body must flow through unchanged")
                        XCTAssertNil(
                            response.headers[HTTPField.Name("Access-Control-Allow-Origin")!],
                            "proxy must not forward upstream Access-Control-Allow-Origin"
                        )
                        XCTAssertNil(
                            response.headers[HTTPField.Name("Access-Control-Allow-Credentials")!],
                            "proxy must not forward upstream Access-Control-Allow-Credentials"
                        )
                        XCTAssertNil(
                            response.headers[HTTPField.Name("Access-Control-Expose-Headers")!],
                            "proxy must not forward upstream Access-Control-Expose-Headers"
                        )
                        XCTAssertNil(
                            response.headers[HTTPField.Name("Access-Control-Max-Age")!],
                            "proxy must not forward upstream Access-Control-Max-Age"
                        )
                    }
                }
            }
        } catch {
            try? await httpClient.shutdown()
            try? await eventLoopGroup.shutdownGracefully()
            throw error
        }
        try await httpClient.shutdown()
        try await eventLoopGroup.shutdownGracefully()
    }

    /// Round-trip helper: stands up a live Hummingbird server hosting an
    /// upstream stub route, registers the API routes (including
    /// `/api/fetch-proxy`) on a separate router used in `.router` (in-memory)
    /// mode, then routes a DAV request through the proxy and asserts the
    /// verb, body, and DAV header reached the upstream unchanged and that
    /// the upstream's 207 Multi-Status response flowed back.
    ///
    /// Two implementation notes:
    ///
    /// - We use an MTELG-backed `HTTPClient` (NIO-Posix sockets) for the
    ///   proxy's outbound call instead of the singleton, which on macOS
    ///   resolves to NIOTransportServices (Network.framework). Network.framework
    ///   has been observed to refuse local-loopback connections with
    ///   `NWPOSIXError 1` in unit-test environments; raw Posix sockets work
    ///   reliably.
    /// - The upstream stub is its own live `Application`; the proxy itself is
    ///   exercised through `.router` mode so the test client invokes the
    ///   proxy handler directly without depending on a second listener.
    private func runDavRoundTripTest(
        method: String,
        davHeaderName: String?,
        davHeaderValue: String?,
        requestBody: String
    ) async throws {
        let httpMethod = try XCTUnwrap(HTTPRequest.Method(rawValue: method))
        let davHeader: HTTPField.Name? = try {
            guard let davHeaderName else { return nil }
            return try XCTUnwrap(HTTPField.Name(davHeaderName))
        }()
        let captured = CapturedRequestBox()

        // Build the upstream stub on its own router/app.
        let upstreamRouter = Router()
        upstreamRouter.on("/upstream", method: httpMethod) { request, _ in
            let body = try await request.body.collect(upTo: 1 * 1024 * 1024)
            await captured.record(
                method: request.method.rawValue,
                davHeader: davHeader.flatMap { request.headers[$0] },
                body: String(buffer: body)
            )
            return Response(
                status: HTTPResponse.Status(code: 207, reasonPhrase: "Multi-Status"),
                headers: [.contentType: "application/xml; charset=utf-8"],
                body: .init(byteBuffer: ByteBuffer(string: "<multistatus/>"))
            )
        }
        let upstreamApp = Application(responder: upstreamRouter.buildResponder())

        // Dedicated MTELG-backed HTTPClient for the proxy's outbound call.
        // On macOS, AsyncHTTPClient's singleton ELG resolves to
        // NIOTransportServices (Network.framework) which has been observed
        // to refuse local-loopback connections with `NWPOSIXError 1` in
        // unit-test environments; raw Posix sockets work reliably.
        let eventLoopGroup = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        let httpClient = HTTPClient(eventLoopGroupProvider: .shared(eventLoopGroup))

        do {
            try await upstreamApp.test(.live) { upstreamClient in
                try await self.executeDavRoundTrip(
                    httpMethod: httpMethod,
                    davHeader: davHeader,
                    davHeaderValue: davHeaderValue,
                    requestBody: requestBody,
                    upstreamPort: try XCTUnwrap(upstreamClient.port, "live test framework must expose a port"),
                    httpClient: httpClient
                )
            }
        } catch {
            try? await httpClient.shutdown()
            try? await eventLoopGroup.shutdownGracefully()
            throw error
        }
        try await httpClient.shutdown()
        try await eventLoopGroup.shutdownGracefully()

        let snapshot = await captured.snapshot()
        XCTAssertEqual(snapshot.method, method, "\(method) verb must reach upstream unchanged")
        if let davHeaderName, let davHeaderValue {
            XCTAssertEqual(
                snapshot.davHeader,
                davHeaderValue,
                "\(davHeaderName) header must reach upstream unchanged"
            )
        }
        XCTAssertEqual(snapshot.body, requestBody, "request body must reach upstream byte-for-byte")
    }

    private func executeDavRoundTrip(
        httpMethod: HTTPRequest.Method,
        davHeader: HTTPField.Name?,
        davHeaderValue: String?,
        requestBody: String,
        upstreamPort: Int,
        httpClient: HTTPClient
    ) async throws {
        let proxyRouter = Router()
        registerAPIRoutes(
            router: proxyRouter,
            lickSystem: LickSystem(),
            config: self.makeConfig(),
            httpClient: httpClient
        )
        let proxyApp = Application(responder: proxyRouter.buildResponder())

        var headers: HTTPFields = [
            HTTPField.Name("X-Target-URL")!: "http://localhost:\(upstreamPort)/upstream",
            .contentType: "application/xml; charset=utf-8",
        ]
        if let davHeader, let davHeaderValue {
            headers[davHeader] = davHeaderValue
        }

        try await proxyApp.test(.router) { proxyClient in
            try await proxyClient.execute(
                uri: "/api/fetch-proxy",
                method: httpMethod,
                headers: headers,
                body: ByteBuffer(string: requestBody)
            ) { response in
                XCTAssertEqual(response.status.code, 207, "207 Multi-Status must flow back to the client")
                XCTAssertEqual(String(buffer: response.body), "<multistatus/>")
            }
        }
    }

    func testOAuthResultRoundTripsAndClears() async throws {
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/oauth-result",
                    method: .post,
                    headers: [.contentType: "application/json"],
                    body: ByteBuffer(string: #"{"redirectUrl":"https://callback.example","error":"denied"}"#)
                ) { response in
                    XCTAssertEqual(response.status, .ok)
                }

                try await client.execute(uri: "/api/oauth-result", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    XCTAssertEqual(
                        try self.decodeJSONObject(from: response.body),
                        [
                            "redirectUrl": .string("https://callback.example"),
                            "error": .string("denied"),
                        ]
                    )
                }

                try await client.execute(uri: "/api/oauth-result", method: .get) { response in
                    XCTAssertEqual(response.status, .noContent)
                }
            }
        }
    }

    private func makeConfig(
        dev: Bool = false,
        leadWorkerBaseUrl: String? = nil,
        joinUrl: String? = nil
    ) -> ServerConfig {
        .init(
            dev: dev,
            serveOnly: false,
            cdpPort: 9222,
            explicitCdpPort: false,
            electron: false,
            electronApp: nil,
            electronAppURL: nil,
            kill: false,
            lead: leadWorkerBaseUrl != nil,
            leadWorkerBaseUrl: leadWorkerBaseUrl,
            leadWorkerBaseURL: leadWorkerBaseUrl.flatMap(URL.init(string:)),
            profile: nil,
            join: joinUrl != nil,
            joinUrl: joinUrl,
            joinURL: joinUrl.flatMap(URL.init(string:)),
            logLevel: "info",
            logDir: nil,
            logDirectoryURL: nil,
            prompt: nil,
            envFile: nil,
            envFileURL: nil
        )
    }

    private func decodeJSONObject(from body: ByteBuffer) throws -> LickSystem.JSONObject {
        try JSONDecoder().decode(LickSystem.JSONObject.self, from: Data(String(buffer: body).utf8))
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

    private func attachResponderClient(
        to lickSystem: LickSystem,
        responder: @escaping @Sendable (LickSystem.JSONObject) throws -> LickSystem.JSONValue
    ) async {
        let client = WebSocketClient { text in
            let request = try LickSystem.decode(text)
            let requestId = try XCTUnwrap(request["requestId"]?.stringValue)
            let response = try responder(request)
            let payload = try LickSystem.encode([
                "type": .string("response"),
                "requestId": .string(requestId),
                "data": response,
            ])
            await lickSystem.handleMessage(text: payload)
        }
        await lickSystem.addClient(client)
    }
}

/// Thread-safe holder for upstream-side request observations captured by
/// the DAV round-trip tests. The stub upstream route runs on the live
/// server's task; the test assertions run on the test task — so a plain
/// `var` would trip the Sendable checker.
private actor CapturedRequestBox {
    struct Snapshot {
        let method: String?
        let davHeader: String?
        let body: String?
    }

    private var method: String?
    private var davHeader: String?
    private var body: String?

    func record(method: String, davHeader: String?, body: String) {
        self.method = method
        self.davHeader = davHeader
        self.body = body
    }

    func snapshot() -> Snapshot {
        .init(method: self.method, davHeader: self.davHeader, body: self.body)
    }
}