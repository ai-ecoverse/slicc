import Foundation
import Logging
import XCTest

@testable import slicc_server

private final class OverlayCommandRecorder: @unchecked Sendable {
    typealias Responder = (String, [String: Any]?, Int) -> [String: Any]?

    struct Entry {
        let method: String
        let params: [String: Any]?
        let awaitResponse: Bool
    }

    private let lock = NSLock()
    private var entries: [Entry] = []
    private let responder: Responder

    init(responder: @escaping Responder = { _, _, _ in nil }) {
        self.responder = responder
    }

    func handle(_ method: String, _ params: [String: Any]?, _ awaitResponse: Bool) async -> [String: Any]? {
        recordAndRespond(method, params, awaitResponse)
    }

    private func recordAndRespond(
        _ method: String,
        _ params: [String: Any]?,
        _ awaitResponse: Bool
    ) -> [String: Any]? {
        lock.withLock {
            entries.append(Entry(method: method, params: params, awaitResponse: awaitResponse))
            let occurrence = entries.filter { $0.method == method }.count
            return responder(method, params, occurrence)
        }
    }

    func snapshot() -> [Entry] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }

    func methods() -> [String] { snapshot().map(\.method) }
}

private final class OverlayFlags: @unchecked Sendable {
    private let lock = NSLock()
    private var bypassed: [String] = []
    private var egressBlocked: [String] = []

    func recordBypassed(_ url: String) {
        lock.lock()
        bypassed.append(url)
        lock.unlock()
    }

    func recordEgressBlocked(_ url: String) {
        lock.lock()
        egressBlocked.append(url)
        lock.unlock()
    }

    func snapshot() -> (bypassed: [String], egressBlocked: [String]) {
        lock.lock()
        defer { lock.unlock() }
        return (bypassed, egressBlocked)
    }
}

private final class OverlayURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (URLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.unknown) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class OverlayTargetSessionCoverageTests: XCTestCase {
    private let target = ElectronInspectableTarget(
        type: "page",
        title: "Demo",
        url: "file:///Applications/Demo.app/index.html",
        webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/demo"
    )

    override func tearDown() {
        OverlayURLProtocol.handler = nil
        super.tearDown()
    }

    private func logger() -> Logger {
        var logger = Logger(label: "overlay-target-session-coverage")
        logger.logLevel = .trace
        return logger
    }

    private func makeSession(
        recorder: OverlayCommandRecorder = OverlayCommandRecorder(),
        flags: OverlayFlags = OverlayFlags(),
        alreadyBypassed: Bool = false,
        alreadyEgressBlocked: Bool = false,
        urlSession: URLSession = .shared,
        presenceInterval: UInt64 = 1_000_000
    ) -> OverlayTargetSession {
        OverlayTargetSession(
            target: target,
            bootstrapScript: "bootstrap()",
            statusBootstrapScript: "status()",
            servePort: 5711,
            bridgeToken: "test-token",
            session: urlSession,
            logger: logger(),
            probeDelayNanoseconds: 0,
            commandTimeoutNanoseconds: 1_000_000,
            presenceCheckIntervalNanoseconds: presenceInterval,
            isAlreadyBypassed: { _ in alreadyBypassed },
            recordBypassed: { flags.recordBypassed($0) },
            isAlreadyEgressBlocked: { _ in alreadyEgressBlocked },
            recordEgressBlocked: { flags.recordEgressBlocked($0) },
            onClose: { _ in },
            commandHandler: recorder.handle
        )
    }

    func testConnectFlowInjectsStatusOnlyForKnownEgressBlock() async {
        let recorder = OverlayCommandRecorder()
        let session = makeSession(recorder: recorder, alreadyEgressBlocked: true)

        await session.runConnectFlow()

        XCTAssertEqual(
            recorder.methods(),
            [
                "Runtime.enable", "Page.enable", "Network.enable",
                "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate",
            ])
    }

    func testConnectFlowForKnownBypassRegistersInjectsAndVerifies() async {
        let recorder = OverlayCommandRecorder { method, params, _ in
            if method == "Page.addScriptToEvaluateOnNewDocument" { return ["identifier": "script-1"] }
            if method == "Runtime.evaluate",
                let expression = params?["expression"] as? String,
                expression.contains("hasGlobal")
            {
                return ["result": ["value": "gr"]]
            }
            return nil
        }
        let session = makeSession(recorder: recorder, alreadyBypassed: true)

        await session.runConnectFlow()
        await session.registerNewDocumentScript()

        XCTAssertTrue(recorder.methods().contains("Page.setBypassCSP"))
        XCTAssertEqual(
            recorder.methods().filter { $0 == "Page.addScriptToEvaluateOnNewDocument" }.count,
            1,
            "the registered-script identifier must suppress duplicate registration"
        )
    }

    func testFirstConnectRecordsImmediateLoadSuccess() async {
        let flags = OverlayFlags()
        let recorder = OverlayCommandRecorder { method, params, _ in
            if method == "Page.addScriptToEvaluateOnNewDocument" { return ["identifier": "script-1"] }
            if method == "Runtime.evaluate" {
                let expression = params?["expression"] as? String ?? ""
                if expression.contains("hasGlobal") { return ["result": ["value": "gr"]] }
                if expression != "bootstrap()" { return ["result": ["value": "ok"]] }
            }
            return nil
        }
        let session = makeSession(recorder: recorder, flags: flags)

        await session.runConnectFlow()

        XCTAssertEqual(flags.snapshot().bypassed, [target.url])
        XCTAssertFalse(recorder.methods().contains("Page.reload"))
    }

    func testFailedFirstProbeReloadsThenRecordsPostReloadSuccess() async {
        let flags = OverlayFlags()
        let recorder = OverlayCommandRecorder { method, params, _ in
            if method == "Runtime.evaluate" {
                let expression = params?["expression"] as? String ?? ""
                if expression.contains("hasGlobal") { return ["result": ["value": "gr"]] }
                if expression != "bootstrap()" { return ["result": ["value": "ok"]] }
            }
            return nil
        }
        let session = makeSession(recorder: recorder, flags: flags)

        await session.handlePostProbe(loaded: false)
        await session.handleEvent(method: "Page.loadEventFired", params: nil)

        XCTAssertEqual(flags.snapshot().bypassed, [target.url])
        XCTAssertEqual(recorder.methods().filter { $0 == "Page.reload" }.count, 1)
    }

    func testFailedReloadEscalatesToFetchProxy() async {
        let recorder = OverlayCommandRecorder { method, params, _ in
            guard method == "Runtime.evaluate" else { return nil }
            let expression = params?["expression"] as? String ?? ""
            return expression.contains("hasGlobal") ? ["result": ["value": "--"]] : ["result": ["value": "blocked"]]
        }
        let session = makeSession(recorder: recorder)

        await session.handlePostProbe(loaded: false)
        await session.handleLoadEventFired()

        XCTAssertTrue(recorder.methods().contains("Fetch.enable"))
        XCTAssertEqual(recorder.methods().filter { $0 == "Page.reload" }.count, 2)
    }

    func testEgressSignalTracksBlocksAndInjectsOnlyOnce() async {
        let recorder = OverlayCommandRecorder()
        let flags = OverlayFlags()
        let session = makeSession(recorder: recorder, flags: flags)
        let request: [String: Any] = [
            "requestId": "overlay-1",
            "type": "Document",
            "request": ["url": "https://www.sliccy.ai/electron?bridgeToken=test-token"],
        ]
        let failure: [String: Any] = [
            "requestId": "overlay-1",
            "type": "Document",
            "errorText": "net::ERR_ACCESS_DENIED",
        ]

        await session.applyNetworkSignal(method: "Network.requestWillBeSent", params: request)
        await session.applyNetworkSignal(method: "Network.loadingFailed", params: failure)
        await session.applyNetworkSignal(method: "Network.loadingFailed", params: failure)
        await session.applyNetworkSignal(method: "Network.loadingFailed", params: ["requestId": "other"])

        XCTAssertEqual(flags.snapshot().egressBlocked, [target.url])
        XCTAssertEqual(recorder.methods().filter { $0 == "Network.disable" }.count, 2)
        XCTAssertEqual(
            recorder.methods().filter { $0 == "Page.addScriptToEvaluateOnNewDocument" }.count,
            1
        )
    }

    func testEgressBlockSuppressesProbeAndReloadHandlers() async {
        let recorder = OverlayCommandRecorder()
        let session = makeSession(recorder: recorder)
        session._testing_setState(
            pendingReload: true,
            pendingCspEscalation: true,
            egressBlocked: true
        )

        await session.handlePostProbe(loaded: true)
        await session.handleLoadEventFired()

        XCTAssertTrue(recorder.methods().isEmpty)
    }

    func testFetchPausedIgnoresInactiveMissingAndNonHTMLRequests() async {
        let recorder = OverlayCommandRecorder()
        let session = makeSession(recorder: recorder)

        await session.handleFetchRequestPaused(params: ["requestId": "inactive"])
        session._testing_setState(fetchProxyActive: true)
        await session.handleFetchRequestPaused(params: [:])
        await session.handleFetchRequestPaused(params: ["requestId": "defaults"])
        await session.handleFetchRequestPaused(params: [
            "requestId": "asset",
            "request": [
                "url": "https://example.test/style.css",
                "method": "GET",
                "headers": ["accept": "text/css"],
            ],
        ])

        XCTAssertEqual(recorder.methods(), ["Fetch.continueRequest", "Fetch.continueRequest"])
    }

    func testLoadEventWithoutEscalationStopsAfterReinjection() async {
        let recorder = OverlayCommandRecorder()
        let session = makeSession(recorder: recorder)
        session._testing_setState(pendingReload: true, pendingCspEscalation: false)

        await session.handleLoadEventFired()

        XCTAssertFalse(recorder.methods().contains("Fetch.enable"))
    }

    func testFetchPausedFailsUnrecoverableAndUpstreamFailures() async {
        let recorder = OverlayCommandRecorder()
        let session = makeSession(recorder: recorder)
        session._testing_setState(fetchProxyActive: true)

        await session.handleFetchRequestPaused(params: [
            "requestId": "upload",
            "request": [
                "url": "https://example.test/upload",
                "method": "POST",
                "headers": ["Accept": "text/html"],
                "hasPostData": true,
                "postDataEntries": [[String: Any]()],
            ],
        ])
        await session.handleFetchRequestPaused(params: [
            "requestId": "bad-url",
            "request": [
                "url": "not a URL",
                "method": "GET",
                "headers": ["Accept": "text/html"],
            ],
        ])

        XCTAssertEqual(recorder.methods(), ["Fetch.failRequest", "Fetch.failRequest"])
    }

    func testFetchPausedFulfillsHTMLAndStripsCSP() async throws {
        let body = Data("hello".utf8)
        OverlayURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Test"), "yes")
            XCTAssertNil(request.value(forHTTPHeaderField: "Host"))
            let response = try XCTUnwrap(
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 201,
                    httpVersion: nil,
                    headerFields: [
                        "Content-Security-Policy": "default-src none",
                        "Content-Length": "999",
                        "Connection": "close",
                        "X-Upstream": "ok",
                    ]
                ))
            return (response, body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OverlayURLProtocol.self]
        let recorder = OverlayCommandRecorder()
        let session = makeSession(
            recorder: recorder,
            urlSession: URLSession(configuration: configuration)
        )
        session._testing_setState(fetchProxyActive: true)

        await session.handleFetchRequestPaused(params: [
            "requestId": "document",
            "request": [
                "url": "https://example.test/form",
                "method": "POST",
                "headers": [
                    "Accept": "text/html",
                    "X-Test": "yes",
                    "Host": "example.test",
                    "Content-Length": "8",
                ],
                "postData": "name=ada",
                "hasPostData": true,
            ],
        ])

        let fulfill = try XCTUnwrap(recorder.snapshot().last)
        XCTAssertEqual(fulfill.method, "Fetch.fulfillRequest")
        XCTAssertEqual(fulfill.params?["responseCode"] as? Int, 201)
        XCTAssertEqual(fulfill.params?["body"] as? String, body.base64EncodedString())
        let headers = try XCTUnwrap(fulfill.params?["responseHeaders"] as? [[String: String]])
        XCTAssertTrue(headers.contains(["name": "Content-Length", "value": "5"]))
        XCTAssertTrue(headers.contains(["name": "X-Upstream", "value": "ok"]))
        XCTAssertFalse(headers.contains { $0["name"]?.lowercased().contains("content-security-policy") == true })
    }

    func testFetchAndStripRejectsNonHTTPResponse() async {
        OverlayURLProtocol.handler = { request in
            (URLResponse(url: request.url!, mimeType: nil, expectedContentLength: 0, textEncodingName: nil), Data())
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OverlayURLProtocol.self]
        let session = makeSession(urlSession: URLSession(configuration: configuration))

        do {
            _ = try await session.fetchAndStripCSP(
                urlString: "https://example.test/",
                method: "GET",
                headers: [:],
                body: nil
            )
            XCTFail("expected bad-server-response")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .badServerResponse)
        }
    }

    func testFetchAndStripRejectsMalformedURL() async {
        let session = makeSession()
        do {
            _ = try await session.fetchAndStripCSP(
                urlString: "http://[",
                method: "GET",
                headers: [:],
                body: nil
            )
            XCTFail("expected malformed URL")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .badURL)
        }
    }

    func testProbeRegistrationVerificationAndReinjectionBranches() async {
        let recorder = OverlayCommandRecorder { method, params, occurrence in
            if method == "Page.addScriptToEvaluateOnNewDocument" {
                return occurrence == 1 ? ["identifier": "script-1"] : nil
            }
            guard method == "Runtime.evaluate" else { return nil }
            let expression = params?["expression"] as? String ?? ""
            if expression.contains("hasGlobal") { return ["result": ["value": occurrence.isMultiple(of: 2) ? "gr" : "--"]] }
            if expression.contains("hasMarker") { return ["result": ["value": "evicted"]] }
            return ["result": ["value": occurrence.isMultiple(of: 2) ? "ok" : "blocked"]]
        }
        let session = makeSession(recorder: recorder)

        await session.registerNewDocumentScript()
        await session.registerNewDocumentScript()
        let firstVerification = await session.verifyOverlayPresent(context: "missing")
        let secondVerification = await session.verifyOverlayPresent(context: "present")
        let firstProbe = await session.probeOverlayLoaded()
        let secondProbe = await session.probeOverlayLoaded()
        let evicted = await session.probeOverlayEvicted()
        XCTAssertFalse(firstVerification)
        XCTAssertTrue(secondVerification)
        XCTAssertFalse(firstProbe)
        XCTAssertTrue(secondProbe)
        XCTAssertTrue(evicted)
        await session.reinjectIfEvicted()
        session._testing_setState(pendingReload: true)
        await session.reinjectIfEvicted()

        XCTAssertTrue(recorder.methods().contains("Page.addScriptToEvaluateOnNewDocument"))
        XCTAssertTrue(recorder.methods().contains("Runtime.evaluate"))
    }

    func testLoadEventWithoutPendingReloadAndGracefulShutdown() async {
        let recorder = OverlayCommandRecorder()
        let session = makeSession(recorder: recorder)

        await session.handleLoadEventFired()
        await session.gracefulShutdown()
        await session.gracefulShutdown()

        XCTAssertEqual(recorder.methods(), ["Runtime.evaluate"])
    }

    func testEventDispatcherPresenceLoopAndMalformedProbeBranches() async throws {
        let recorder = OverlayCommandRecorder { method, params, _ in
            guard method == "Runtime.evaluate" else { return nil }
            let expression = params?["expression"] as? String ?? ""
            if expression.contains("hasMarker") { return ["result": ["value": "evicted"]] }
            return nil
        }
        let session = makeSession(recorder: recorder, presenceInterval: 1_000_000)

        await session.handleEvent(method: "Fetch.requestPaused", params: nil)
        await session.handleEvent(method: "Network.requestWillBeSent", params: nil)
        await session.handleEvent(
            method: "Page.navigatedWithinDocument",
            params: ["frameId": "main", "url": target.url]
        )
        try await Task.sleep(nanoseconds: 5_000_000)

        let loop = Task { await session.runPresenceCheckLoop() }
        try await Task.sleep(nanoseconds: 5_000_000)
        session.stop()
        await loop.value

        let emptyRegistration = makeSession(recorder: OverlayCommandRecorder())
        await emptyRegistration.registerNewDocumentScript()
        let loaded = await emptyRegistration.probeOverlayLoaded()
        XCTAssertFalse(loaded)
        emptyRegistration.stop()

        XCTAssertTrue(recorder.methods().contains("Fetch.requestPaused") == false)
        XCTAssertTrue(recorder.methods().contains("Runtime.evaluate"))
        XCTAssertTrue(recorder.methods().contains("Network.disable") == false)
    }

    func testStartWithoutDebuggerURLReturnsImmediately() {
        let session = OverlayTargetSession(
            target: ElectronInspectableTarget(type: "page", title: nil, url: "file:///x", webSocketDebuggerURL: nil),
            bootstrapScript: "",
            statusBootstrapScript: "",
            servePort: 0,
            bridgeToken: "",
            session: .shared,
            logger: logger(),
            probeDelayNanoseconds: 0,
            isAlreadyBypassed: { _ in false },
            recordBypassed: { _ in },
            isAlreadyEgressBlocked: { _ in false },
            recordEgressBlocked: { _ in },
            onClose: { _ in }
        )

        session.start()
        session.stop()
    }
}
