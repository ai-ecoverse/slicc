import AsyncHTTPClient
import CommonCrypto
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import NIOCore
import NIOPosix
import XCTest

@testable import slicc_server




private func referenceHmacSHA256Hex(key: String, message: String) -> String {
    let keyData = Array(key.utf8)
    let messageData = Array(message.utf8)
    var result = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), keyData, keyData.count, messageData, messageData.count, &result)
    return result.map { String(format: "%02x", $0) }.joined()
}

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

    func testAgentActivityEndpointTracksRequestsButNotOptions() async throws {
        try await self.withHTTPClient { httpClient in
            let tracker = AgentActivityTracker()
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                agentActivityTracker: tracker
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/fetch-proxy", method: .options) { response in
                    XCTAssertEqual(response.status, .badRequest)
                }
                try await client.execute(uri: "/api/agent-activity", method: .get) { response in
                    XCTAssertEqual(response.headers[HTTPField.Name("Cache-Control")!], "no-store")
                    XCTAssertEqual(
                        try self.decodeJSONObject(from: response.body),
                        ["activeInLastMinute": .bool(false)]
                    )
                }

                try await client.execute(
                    uri: "/api/fetch-proxy",
                    method: .get,
                    headers: [HTTPField.Name("X-Target-URL")!: "http://127.0.0.1:1/never"]
                ) { response in
                    XCTAssertEqual(response.status, .badGateway)
                }
                try await client.execute(uri: "/api/agent-activity", method: .get) { response in
                    XCTAssertEqual(
                        try self.decodeJSONObject(from: response.body),
                        ["activeInLastMinute": .bool(true)]
                    )
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
                    joinUrl: "https://join.example/session",
                    mounts: [
                        ServerConfig.MountMapping(
                            hostPath: NSTemporaryDirectory(), path: "/mnt/project")
                    ]
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
                            "autoMounts": .array([
                                .object([
                                    "path": .string("/mnt/project"),
                                    "hostPath": .string(
                                        URL(fileURLWithPath: NSTemporaryDirectory())
                                            .resolvingSymlinksInPath().path),
                                ])
                            ]),
                        ]
                    )
                }
            }
        }
    }

    func testRuntimeConfigDefaultsToProductionUrl() async throws {
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
                config: self.makeConfig(),
                httpClient: httpClient
            )

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/api/runtime-config", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    let body = try self.decodeJSONObject(from: response.body)
                    XCTAssertEqual(body["trayWorkerBaseUrl"], .string("https://www.sliccy.ai"))
                    XCTAssertEqual(body["trayJoinUrl"], .null)
                    XCTAssertEqual(body["autoMounts"], .array([]))
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

    func testAuthCallbackAlwaysPostsResultRegardlessOfOpener() async throws {
        
        
        
        
        
        
        
        
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/auth/callback?code=abc", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    let html = String(buffer: response.body)
                    guard let fetchRange = html.range(of: "fetch('/api/oauth-result'") else {
                        XCTFail("callback script has no /api/oauth-result POST")
                        return
                    }
                    
                    
                    
                    
                    
                    
                    
                    
                    func skipBraceBlock(from openBrace: String.Index) -> String.Index? {
                        var depth = 1
                        var idx = html.index(after: openBrace)
                        while depth > 0 {
                            guard idx < html.endIndex else { return nil }
                            if html[idx] == "{" { depth += 1 }
                            if html[idx] == "}" { depth -= 1 }
                            idx = html.index(after: idx)
                        }
                        return idx
                    }
                    guard let ifRange = html.range(of: "if (window.opener)"),
                        let ifOpenBrace = html[ifRange.upperBound...].firstIndex(of: "{"),
                        var boundary = skipBraceBlock(from: ifOpenBrace)
                    else {
                        XCTFail("could not locate/parse the `if (window.opener) { ... }` block")
                        return
                    }
                    let afterIf = html[boundary...].drop(while: { $0 == " " || $0 == "\n" || $0 == "\t" })
                    if afterIf.hasPrefix("else") {
                        guard let elseOpenBrace = afterIf.firstIndex(of: "{"),
                            let afterElse = skipBraceBlock(from: elseOpenBrace)
                        else {
                            XCTFail("could not parse the `else { ... }` block")
                            return
                        }
                        boundary = afterElse
                    }
                    XCTAssertTrue(
                        fetchRange.lowerBound >= boundary,
                        "POST must not be gated behind either the opener or opener-absent branch"
                    )
                }
            }
        }
    }

    func testAuthCallbackDefersCloseUntilResultPosted() async throws {
        
        
        
        
        
        
        
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(router: router, lickSystem: LickSystem(), config: self.makeConfig(), httpClient: httpClient)

            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(uri: "/auth/callback?code=abc", method: .get) { response in
                    XCTAssertEqual(response.status, .ok)
                    let html = String(buffer: response.body)
                    XCTAssertTrue(
                        html.contains("keepalive: true"),
                        "relay POST must set keepalive so it survives window teardown"
                    )
                    XCTAssertTrue(
                        html.contains(".finally(closeWindow)"),
                        "window must close only after the relay POST settles"
                    )
                    XCTAssertTrue(
                        html.contains("setTimeout(closeWindow"),
                        "a fallback timer must close the window if the POST hangs"
                    )
                    guard let fetchRange = html.range(of: "fetch('/api/oauth-result'"),
                        let closeRange = html.range(of: "window.close();")
                    else {
                        XCTFail("callback script missing fetch or window.close()")
                        return
                    }
                    
                    
                    
                    
                    XCTAssertTrue(
                        closeRange.lowerBound < fetchRange.lowerBound,
                        "window.close() must live in the pre-fetch closeWindow helper, not fire synchronously after the POST"
                    )
                }
            }
        }
    }

    func testFetchProxyMissingTargetURLIsTaggedAsProxyError() async throws {
        
        
        
        
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

    
    
    
    
    func testFetchProxyForwardsJpegRequestBytesUnchanged() async throws {
        let probe: [UInt8] = [0xff, 0xd8, 0xff, 0x98, 0x00, 0x41, 0x7f, 0x80, 0xfe]
        try await self.runBinaryBodyRoundTrip(contentType: "image/jpeg", probe: probe)
        try await self.runBinaryBodyRoundTrip(contentType: nil, probe: probe)
    }

    
    
    
    
    func testFetchProxyStripsRawBodyAndBridgeTokenHeaders() async throws {
        let captured = InternalHeaderCaptureBox()
        let upstreamRouter = Router()
        upstreamRouter.post("/upstream") { request, _ in
            await captured.record(
                rawBodyPresent: request.headers[HTTPField.Name("x-slicc-raw-body")!] != nil,
                bridgeTokenPresent: request.headers[HTTPField.Name("x-bridge-token")!] != nil
            )
            return Response(status: .ok, body: .init(byteBuffer: ByteBuffer(string: "ok")))
        }
        let upstreamApp = Application(responder: upstreamRouter.buildResponder())
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
                        method: .post,
                        headers: [
                            HTTPField.Name("X-Target-URL")!: "http://localhost:\(upstreamPort)/upstream",
                            .contentType: "image/jpeg",
                            HTTPField.Name("x-slicc-raw-body")!: "1",
                            HTTPField.Name("x-bridge-token")!: "session-scoped-bridge-token",
                        ],
                        body: ByteBuffer(bytes: [0xff, 0xd8, 0xff, 0x98])
                    ) { response in
                        XCTAssertEqual(response.status, .ok)
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

        let snapshot = await captured.snapshot()
        XCTAssertFalse(snapshot.rawBodyPresent, "x-slicc-raw-body must never reach upstream")
        XCTAssertFalse(snapshot.bridgeTokenPresent, "x-bridge-token must never reach upstream")
    }

    
    
    
    
    
    
    
    
    
    

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
        
        
        
        
        
        try await self.runDavRoundTripTest(
            method: "MKCALENDAR",
            davHeaderName: nil,
            davHeaderValue: nil,
            requestBody: ""
        )
    }

    func testFetchProxyForwardsLockWithBodyAndTimeoutHeader() async throws {
        
        
        
        
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

    
    
    
    
    
    
    func testFetchProxyStripsUpstreamAccessControlHeaders() async throws {
        
        
        
        
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
                            HTTPField.Name("X-Target-URL")!: "http://localhost:\(upstreamPort)/upstream"
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
                            response.headers[HTTPField.Name("Access-Control-Max-Age")!],
                            "proxy must not forward upstream Access-Control-Max-Age"
                        )
                        
                        
                        let expose = response.headers[HTTPField.Name("Access-Control-Expose-Headers")!] ?? ""
                        XCTAssertFalse(
                            expose.lowercased() == "x-evil",
                            "proxy must not forward upstream Access-Control-Expose-Headers verbatim"
                        )
                        XCTAssertTrue(
                            expose.lowercased().contains("content-type"),
                            "proxy must expose forwarded Content-Type"
                        )
                        XCTAssertTrue(
                            expose.lowercased().contains("x-proxy-set-cookie")
                                || expose.lowercased().contains("cache-control"),
                            "proxy must expose its own marker headers"
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

    
    
    
    
    
    func testFetchProxySignsRequestBodyViaHmacSentinelAndStripsSentinel() async throws {
        let hmacSecret = "job-signing-secret-abcdefghijklmnop"
        let injector = SecretInjector(secrets: [
            .init(name: "SIGNING_KEY", realValue: hmacSecret, maskedValue: "masked-signing-key", domains: ["localhost"])
        ])
        let captured = HeaderCaptureBox()

        let upstreamRouter = Router()
        upstreamRouter.post("/upstream") { request, _ in
            let body = try await request.body.collect(upTo: 1 * 1024 * 1024)
            await captured.record(
                body: String(buffer: body),
                jobSignature: request.headers[HTTPField.Name("x-job-signature")!],
                sentinelStillPresent: request.headers[HTTPField.Name("x-slicc-hmac-sign")!] != nil
            )
            return Response(status: .ok, body: .init(byteBuffer: ByteBuffer(string: "done")))
        }
        let upstreamApp = Application(responder: upstreamRouter.buildResponder())

        let eventLoopGroup = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        let httpClient = HTTPClient(eventLoopGroupProvider: .shared(eventLoopGroup))
        let body = #"{"step":3,"status":"running"}"#

        do {
            try await upstreamApp.test(.live) { upstreamClient in
                let upstreamPort = try XCTUnwrap(upstreamClient.port, "live test framework must expose a port")
                let proxyRouter = Router()
                registerAPIRoutes(
                    router: proxyRouter,
                    lickSystem: LickSystem(),
                    config: self.makeConfig(),
                    httpClient: httpClient,
                    secretInjector: injector
                )
                let proxyApp = Application(responder: proxyRouter.buildResponder())

                try await proxyApp.test(.router) { proxyClient in
                    try await proxyClient.execute(
                        uri: "/api/fetch-proxy",
                        method: .post,
                        headers: [
                            HTTPField.Name("X-Target-URL")!: "http://localhost:\(upstreamPort)/upstream",
                            .contentType: "application/json",
                            HTTPField.Name("x-slicc-hmac-sign")!: "SIGNING_KEY:x-job-signature",
                        ],
                        body: ByteBuffer(string: body)
                    ) { response in
                        XCTAssertEqual(response.status, .ok)
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

        let snapshot = await captured.snapshot()
        XCTAssertEqual(snapshot.body, body, "body must reach upstream unchanged")
        XCTAssertEqual(
            snapshot.jobSignature,
            referenceHmacSHA256Hex(key: hmacSecret, message: body),
            "x-job-signature must equal HMAC-SHA256(body, real secret value)"
        )
        XCTAssertFalse(snapshot.sentinelStillPresent, "x-slicc-hmac-sign must never reach upstream")
    }

    
    
    func testFetchProxySignHmacReturns403ForOutOfScopeDomain() async throws {
        let injector = SecretInjector(secrets: [
            .init(name: "SIGNING_KEY", realValue: "job-signing-secret-value", maskedValue: "masked-signing-key", domains: ["api.github.com"])
        ])
        try await self.withHTTPClient { httpClient in
            let router = Router()
            registerAPIRoutes(
                router: router,
                lickSystem: LickSystem(),
                config: self.makeConfig(),
                httpClient: httpClient,
                secretInjector: injector
            )
            let app = Application(responder: router.buildResponder())
            try await app.test(.router) { client in
                try await client.execute(
                    uri: "/api/fetch-proxy",
                    method: .post,
                    headers: [
                        HTTPField.Name("X-Target-URL")!: "http://localhost:9/upstream",
                        .contentType: "application/json",
                        HTTPField.Name("x-slicc-hmac-sign")!: "SIGNING_KEY:x-job-signature",
                    ],
                    body: ByteBuffer(string: "{}")
                ) { response in
                    XCTAssertEqual(response.status, .forbidden)
                }
            }
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    private func runBinaryBodyRoundTrip(contentType: String?, probe: [UInt8]) async throws {
        let captured = BinaryCaptureBox()
        let upstreamRouter = Router()
        upstreamRouter.post("/upstream") { request, _ in
            let body = try await request.body.collect(upTo: 1 * 1024 * 1024)
            await captured.record(bytes: body.getBytes(at: body.readerIndex, length: body.readableBytes) ?? [])
            return Response(status: .ok, body: .init(byteBuffer: ByteBuffer(string: "ok")))
        }
        let upstreamApp = Application(responder: upstreamRouter.buildResponder())
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
                let headers: HTTPFields = {
                    var fields: HTTPFields = [
                        HTTPField.Name("X-Target-URL")!: "http://localhost:\(upstreamPort)/upstream"
                    ]
                    if let contentType {
                        fields[.contentType] = contentType
                    }
                    return fields
                }()
                try await proxyApp.test(.router) { proxyClient in
                    try await proxyClient.execute(
                        uri: "/api/fetch-proxy",
                        method: .post,
                        headers: headers,
                        body: ByteBuffer(bytes: probe)
                    ) { response in
                        XCTAssertEqual(response.status, .ok)
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
        let seen = await captured.snapshot()
        XCTAssertEqual(seen, probe, "JPEG probe bytes must reach upstream unchanged")
    }

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
                    body: ByteBuffer(string: #"{"redirectUrl":"https:
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
        leadWorkerBaseUrl: String? = nil,
        joinUrl: String? = nil,
        mounts: [ServerConfig.MountMapping] = []
    ) -> ServerConfig {
        .init(
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
            envFileURL: nil,
            mounts: mounts
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



private actor BinaryCaptureBox {
    private var bytes: [UInt8] = []

    func record(bytes: [UInt8]) {
        self.bytes = bytes
    }

    func snapshot() -> [UInt8] {
        self.bytes
    }
}





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



private actor HeaderCaptureBox {
    struct Snapshot {
        let body: String?
        let jobSignature: String?
        let sentinelStillPresent: Bool
    }

    private var body: String?
    private var jobSignature: String?
    private var sentinelStillPresent = false

    func record(body: String, jobSignature: String?, sentinelStillPresent: Bool) {
        self.body = body
        self.jobSignature = jobSignature
        self.sentinelStillPresent = sentinelStillPresent
    }

    func snapshot() -> Snapshot {
        .init(body: self.body, jobSignature: self.jobSignature, sentinelStillPresent: self.sentinelStillPresent)
    }
}



private actor InternalHeaderCaptureBox {
    struct Snapshot {
        let rawBodyPresent: Bool
        let bridgeTokenPresent: Bool
    }

    private var rawBodyPresent = false
    private var bridgeTokenPresent = false

    func record(rawBodyPresent: Bool, bridgeTokenPresent: Bool) {
        self.rawBodyPresent = rawBodyPresent
        self.bridgeTokenPresent = bridgeTokenPresent
    }

    func snapshot() -> Snapshot {
        .init(rawBodyPresent: self.rawBodyPresent, bridgeTokenPresent: self.bridgeTokenPresent)
    }
}
