import AsyncHTTPClient
import Foundation
import Hummingbird
import HummingbirdWebSocket
import HTTPTypes
import Logging
import NIOCore
import NIOHTTP1
import NIOWebSocket
import WebSocketKit

actor CDPProxy {
    static let defaultMaxMessageSize = 100 * 1024 * 1024
    static let defaultChromeInboundMessageBufferLimit = 1_000
    static let defaultReconnectDelayNanoseconds: UInt64 = 1_000_000_000

    /// WebSocket close code SLICC sends when the proxy hands its single `/cdp`
    /// client slot to a newer client (another SLICC tab/window). The webapp
    /// `CDPClient` latches on this exact code (see
    /// `packages/webapp/src/cdp/cdp-client.ts` `CDP_SUPERSEDED_CLOSE_CODE`) and
    /// stops re-dialing, so the two tabs don't fight over the slot — matching
    /// node-server's CDP-war guard (PR #1096). `.goingAway` (1001) would not
    /// match the latch, so a Sliccstart user would see the eviction war.
    static let supersededCloseCode: UInt16 = 4001

    private let logger: Logger
    private let logDedup: CliLogDedup
    private let discoverer: @Sendable (Int) async throws -> String
    private let chromeConnector: ChromeSocketConnector
    private let maxMessageSize: Int
    private let maxBufferSize = 1_000
    private let reconnectDelayNanoseconds: UInt64
    private let sleep: @Sendable (UInt64) async throws -> Void
    private let secretInjector: SecretInjector?

    private var cdpPort: Int?
    private var cachedCDPPort: Int?
    private var cachedCDPURL: String?
    private var chromeSocket: ChromeSocketHandle?
    private var chromeConnectionID: UUID?
    private var chromeConnectionTask: Task<ChromeSocketHandle, Error>?
    private var chromeReconnectTask: Task<Void, Never>?
    private var activeClient: ClientHandle?
    private var messageBuffer: [ProxyMessage]?

    // Session→URL tracking populated by sniffing Chrome→Client frames. Used
    // to gate Client→Chrome secret unmasking by the target tab's current
    // hostname. Empty/no-entry means we cannot resolve the URL → fail closed.
    private var sessionToUrl: [String: String] = [:]
    private var sessionToTargetId: [String: String] = [:]
    private var sessionToRootFrame: [String: String] = [:]

    init(
        logger: Logger = Logger(label: "slicc.cdp-proxy"),
        maxMessageSize: Int = CDPProxy.defaultMaxMessageSize,
        discoverer: (@Sendable (Int) async throws -> String)? = nil,
        chromeConnector: ChromeSocketConnector? = nil,
        reconnectDelayNanoseconds: UInt64 = CDPProxy.defaultReconnectDelayNanoseconds,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
        secretInjector: SecretInjector? = nil
    ) {
        self.logger = logger
        self.maxMessageSize = maxMessageSize
        self.discoverer = discoverer ?? Self.defaultDiscoverCDPURL(port:)
        self.chromeConnector = chromeConnector ?? { url, onMessage, onEvent in
            try await Self.defaultChromeConnector(
                url: url,
                maxFrameSize: maxMessageSize,
                onMessage: onMessage,
                onEvent: onEvent
            )
        }
        self.reconnectDelayNanoseconds = reconnectDelayNanoseconds
        self.sleep = sleep
        self.secretInjector = secretInjector
        self.logDedup = CliLogDedup(prefix: "[cdp-proxy]", sink: { summary in
            logger.debug("\(summary)")
        })
    }

    /// Install the `/cdp` route on `router`.
    ///
    /// When `bridgeToken` is non-nil (thin standalone mode), the WebSocket
    /// upgrade is gated by `BridgeSecurity.validateUpgrade`: bad origin or
    /// missing/wrong `Sec-WebSocket-Protocol` token → `.dontUpgrade` (405)
    /// before any handler runs. The accepted subprotocol is echoed back in
    /// the 101 response (RFC 6455 §1.9) so the browser does not close the
    /// socket. Legacy modes (dev / electron / serve-only) pass `nil` to keep
    /// the same-origin behavior unchanged.
    func install(
        on router: Router<BasicWebSocketRequestContext>,
        cdpPort: Int,
        bridgeToken: String? = nil
    ) {
        self.cdpPort = cdpPort
        let proxyLogger = self.logger
        router.ws("/cdp") { request, _ in
            Self.evaluateBridgeUpgrade(
                origin: request.headers[.origin],
                subprotocolHeader: request.headers[.secWebSocketProtocol],
                bridgeToken: bridgeToken,
                onReject: { reason in
                    proxyLogger.warning("[cdp-proxy] /cdp upgrade rejected: \(reason)")
                }
            )
        } onUpgrade: { inbound, outbound, context in
            try await self.handleClientConnection(
                inbound: inbound,
                outbound: outbound,
                context: context,
                cdpPort: cdpPort
            )
        }
    }

    /// Pure decision logic for the `/cdp` WebSocket upgrade gate. Returns
    /// `.upgrade([:])` in legacy modes (`bridgeToken == nil`) so existing
    /// dev / serve-only / electron-without-hosted-origin paths see no
    /// behavior change. In thin modes (`bridgeToken != nil`), runs the
    /// origin allowlist + `Sec-WebSocket-Protocol` token check from
    /// `BridgeSecurity.validateUpgrade` and, on success, echoes the
    /// accepted subprotocol back in the 101 response (RFC 6455 §1.9 — the
    /// browser otherwise closes the socket). Extracted from `install()` so
    /// the gate is unit-testable without spinning up Hummingbird.
    static func evaluateBridgeUpgrade(
        origin: String?,
        subprotocolHeader: String?,
        bridgeToken: String?,
        onReject: ((String) -> Void)? = nil
    ) -> RouterShouldUpgrade {
        guard let bridgeToken else {
            return .upgrade([:])
        }
        let gate = BridgeSecurity.validateUpgrade(
            origin: origin,
            subprotocolHeader: subprotocolHeader,
            expectedToken: bridgeToken
        )
        guard gate.ok, let accepted = gate.acceptedSubprotocol else {
            let reason = gate.reason?.rawValue ?? "rejected"
            onReject?(reason)
            return .dontUpgrade
        }
        var headers = HTTPFields()
        headers[.secWebSocketProtocol] = accepted
        return .upgrade(headers)
    }

    func preWarm(cdpPort: Int) async throws {
        self.cdpPort = cdpPort
        let cdpURL = try await self.cdpURL(for: cdpPort)
        try await self.ensureChromeConnection(url: cdpURL)
    }

    func discoverCDPUrl(port: Int) async throws -> String {
        try await self.discoverer(port)
    }

    func ensureChromeConnection(url: String) async throws {
        if let chromeSocket, chromeSocket.isOpen() {
            try await self.flushBufferedMessages(using: chromeSocket)
            return
        }

        if let chromeConnectionTask {
            let chromeSocket = try await chromeConnectionTask.value
            if self.chromeSocket == nil {
                self.chromeSocket = chromeSocket
            }
            try await self.flushBufferedMessages(using: chromeSocket)
            return
        }

        if let chromeSocket {
            await chromeSocket.close()
            self.chromeSocket = nil
        }

        let connectionID = UUID()
        let connectTask = Task<ChromeSocketHandle, Error> {
            try await self.chromeConnector(
                url,
                { [weak self] message in
                    guard let self else { return }
                    await self.handleChromeMessage(message, connectionID: connectionID)
                },
                { [weak self] event in
                    guard let self else { return }
                    await self.handleChromeEvent(event, connectionID: connectionID)
                }
            )
        }

        self.chromeConnectionID = connectionID
        self.chromeConnectionTask = connectTask

        do {
            let chromeSocket = try await connectTask.value
            guard self.chromeConnectionID == connectionID else {
                await chromeSocket.close()
                return
            }

            self.chromeSocket = chromeSocket
            self.chromeConnectionTask = nil
            self.logger.info("[cdp-proxy] chromeWs open")
            try await self.flushBufferedMessages(using: chromeSocket)
        } catch {
            if self.chromeConnectionID == connectionID {
                self.chromeConnectionTask = nil
                self.chromeSocket = nil
            }
            self.logger.error("[cdp-proxy] Chrome WS error: \(String(describing: error))")
            throw error
        }
    }

    func addClient(_ client: ClientHandle) async {
        if let activeClient {
            self.logger.info("[cdp-proxy] Closing previous client connection")
            // Close code 4001 (not 1001/.goingAway) so the webapp CDPClient
            // latches "superseded" and stops re-dialing — otherwise the two
            // SLICC tabs evict each other in a loop. See `supersededCloseCode`.
            await activeClient.close(.unknown(Self.supersededCloseCode), "Replaced by newer /cdp client")
        }

        self.activeClient = client
        if self.messageBuffer == nil {
            self.messageBuffer = []
        }
        self.logger.info("[cdp-proxy] New client connected")
    }

    func receive(_ message: ProxyMessage, from clientID: UUID) async {
        guard self.activeClient?.id == clientID else {
            return
        }

        let outgoing = self.maybeUnmaskClientFrame(message)
        let preview = outgoing.preview
        if let chromeSocket, chromeSocket.isOpen(), self.messageBuffer == nil {
            let logLine = "[cdp-proxy] Client→Chrome: \(preview)"
            if self.logDedup.shouldLog(logLine) {
                self.logger.debug("\(logLine)")
            }

            do {
                try await chromeSocket.send(outgoing)
            } catch {
                self.logger.error("[cdp-proxy] Chrome WS error: \(String(describing: error))")
                self.handleChromeDisconnect(
                    reason: "send failure: \(String(describing: error))",
                    bufferMessage: outgoing
                )
            }
        } else if self.messageBuffer != nil {
            self.appendBufferedMessage(outgoing)
            let logLine = "[cdp-proxy] Client→Chrome (buffered): \(preview)"
            if self.logDedup.shouldLog(logLine) {
                self.logger.debug("\(logLine)")
            }
        } else {
            self.logger.warning("[cdp-proxy] Client→Chrome (DROPPED — no connection): \(preview)")
        }
    }

    func removeClient(id: UUID, reason: String) async {
        guard self.activeClient?.id == id else {
            return
        }
        self.activeClient = nil
        self.logger.info("[cdp-proxy] \(reason)")
    }

    func prepareClientConnection(for clientID: UUID, cdpPort: Int) async {
        do {
            self.cdpPort = cdpPort
            let cdpURL = try await self.cdpURL(for: cdpPort)
            try await self.ensureChromeConnection(url: cdpURL)
        } catch {
            self.logger.error("[cdp-proxy] Connection error: \(String(describing: error))")
            if self.activeClient?.id == clientID {
                await self.activeClient?.close(.goingAway, "Failed to connect to Chrome CDP")
                self.activeClient = nil
            }
        }
    }

    func shutdown() async {
        self.chromeConnectionTask?.cancel()
        self.chromeReconnectTask?.cancel()
        self.chromeConnectionTask = nil
        self.chromeReconnectTask = nil
        self.chromeConnectionID = nil
        self.messageBuffer = nil

        if let chromeSocket = self.chromeSocket {
            await chromeSocket.close()
            self.chromeSocket = nil
        }

        if let activeClient = self.activeClient {
            await activeClient.close(.goingAway, "Server shutting down")
            self.activeClient = nil
        }
    }

    private func cdpURL(for port: Int) async throws -> String {
        if self.cachedCDPPort == port, let cachedCDPURL {
            return cachedCDPURL
        }

        let discoveredURL = try await Self.cdpURL(for: port, using: self.discoverer)
        self.cachedCDPPort = port
        self.cachedCDPURL = discoveredURL
        self.logger.info("[cdp-proxy] CDP available at: \(discoveredURL)")
        return discoveredURL
    }

    private func appendBufferedMessage(_ message: ProxyMessage) {
        guard var buffer = self.messageBuffer else {
            return
        }

        if buffer.count >= self.maxBufferSize {
            self.logger.warning("[cdp-proxy] Message buffer full (\(self.maxBufferSize)), dropping oldest message")
            buffer.removeFirst()
        }

        buffer.append(message)
        self.messageBuffer = buffer
    }

    private func flushBufferedMessages(using chromeSocket: ChromeSocketHandle) async throws {
        guard let bufferedMessages = self.messageBuffer else {
            return
        }

        self.messageBuffer = nil
        for bufferedMessage in bufferedMessages {
            try await chromeSocket.send(bufferedMessage)
        }
    }

    private func handleChromeMessage(_ message: ProxyMessage, connectionID: UUID) async {
        guard self.chromeConnectionID == connectionID else {
            return
        }

        if self.secretInjector != nil, case .text(let text) = message {
            self.sniffSessionTracking(text: text)
        }

        let logLine = "[cdp-proxy] Chrome→Client: \(message.preview)"
        if self.logDedup.shouldLog(logLine) {
            self.logger.debug("\(logLine)")
        }

        guard let activeClient = self.activeClient else {
            return
        }

        do {
            try await activeClient.send(message)
        } catch {
            self.logger.error("[cdp-proxy] Client WS error: \(String(describing: error))")
            if self.activeClient?.id == activeClient.id {
                self.activeClient = nil
            }
        }
    }

    // MARK: - Session→URL tracking + Client→Chrome unmask
    //
    // Mirrors the field surface of `packages/shared-ts/src/cdp-frame-unmask.ts`
    // (the TS helper cannot be imported into Swift). Three CDP methods carry
    // a single whole masked token in one frame: `Runtime.callFunctionOn`
    // (string entries in `params.arguments[].value`), `Runtime.evaluate`
    // (`params.expression`), and `Input.insertText` (`params.text`). The
    // hostname is resolved from the per-session URL populated by sniffing
    // `Target.attachedToTarget`, `Target.targetInfoChanged`, and
    // `Page.frameNavigated` events on the Chrome→Client leg. Fail-closed:
    // when no URL is available, the frame is forwarded verbatim.

    func sessionURLSnapshot() -> [String: String] { self.sessionToUrl }

    func sessionRootFrameSnapshot() -> [String: String] { self.sessionToRootFrame }

    private func sniffSessionTracking(text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        guard let method = obj["method"] as? String,
              let params = obj["params"] as? [String: Any] else {
            return
        }
        switch method {
        case "Target.attachedToTarget":
            guard let sid = params["sessionId"] as? String,
                  let info = params["targetInfo"] as? [String: Any] else { return }
            if let url = info["url"] as? String, !url.isEmpty {
                self.sessionToUrl[sid] = url
            }
            if let tid = info["targetId"] as? String {
                self.sessionToTargetId[sid] = tid
            }
        case "Target.detachedFromTarget":
            if let sid = params["sessionId"] as? String {
                self.sessionToUrl.removeValue(forKey: sid)
                self.sessionToTargetId.removeValue(forKey: sid)
                self.sessionToRootFrame.removeValue(forKey: sid)
            }
        case "Target.targetInfoChanged":
            guard let info = params["targetInfo"] as? [String: Any],
                  let tid = info["targetId"] as? String,
                  let url = info["url"] as? String, !url.isEmpty else { return }
            for (sid, mappedTid) in self.sessionToTargetId where mappedTid == tid {
                self.sessionToUrl[sid] = url
            }
        case "Page.frameNavigated":
            guard let sid = obj["sessionId"] as? String,
                  let frame = params["frame"] as? [String: Any] else { return }
            // Only update on main-frame navigations. CDP frames carry a
            // `parentId` field for subframes; main frames omit it (or send
            // an empty string).
            let parentId = (frame["parentId"] as? String) ?? ""
            guard parentId.isEmpty else { return }
            if let fid = frame["id"] as? String {
                self.sessionToRootFrame[sid] = fid
            }
            if let url = frame["url"] as? String, !url.isEmpty {
                self.sessionToUrl[sid] = url
            }
        default:
            break
        }
    }

    func maybeUnmaskClientFrame(_ message: ProxyMessage) -> ProxyMessage {
        guard let injector = self.secretInjector else { return message }
        guard case .text(let text) = message else { return message }
        return Self.unmaskClientFrame(
            text: text,
            injector: injector,
            urlForSession: { [sessionToUrl] sid in sessionToUrl[sid] }
        ).map { ProxyMessage.text($0) } ?? message
    }

    static func unmaskClientFrame(
        text: String,
        injector: SecretInjector,
        urlForSession: (String) -> String?
    ) -> String? {
        guard !injector.isEmpty else { return nil }
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let method = obj["method"] as? String else {
            return nil
        }
        let targets: Set<String> = ["Runtime.callFunctionOn", "Runtime.evaluate", "Input.insertText"]
        guard targets.contains(method) else { return nil }
        // Fail closed: any missing piece (sessionId, URL, hostname) → no unmask.
        guard let sid = obj["sessionId"] as? String,
              let url = urlForSession(sid),
              let host = URL(string: url)?.host,
              !host.isEmpty else {
            return nil
        }
        guard var params = obj["params"] as? [String: Any] else { return nil }
        var changed = false
        switch method {
        case "Runtime.evaluate":
            if let expr = params["expression"] as? String {
                let unmasked = injector.injectBody(text: expr, hostname: host)
                if unmasked != expr {
                    params["expression"] = unmasked
                    changed = true
                }
            }
        case "Input.insertText":
            if let t = params["text"] as? String {
                let unmasked = injector.injectBody(text: t, hostname: host)
                if unmasked != t {
                    params["text"] = unmasked
                    changed = true
                }
            }
        case "Runtime.callFunctionOn":
            guard var args = params["arguments"] as? [Any] else { return nil }
            var argsChanged = false
            for i in args.indices {
                guard var arg = args[i] as? [String: Any],
                      let value = arg["value"] as? String else { continue }
                let unmasked = injector.injectBody(text: value, hostname: host)
                if unmasked != value {
                    arg["value"] = unmasked
                    args[i] = arg
                    argsChanged = true
                }
            }
            if argsChanged {
                params["arguments"] = args
                changed = true
            }
        default:
            break
        }
        guard changed else { return nil }
        var newObj = obj
        newObj["params"] = params
        guard let newData = try? JSONSerialization.data(withJSONObject: newObj, options: []),
              let newText = String(data: newData, encoding: .utf8) else {
            return nil
        }
        return newText
    }

    private func handleChromeEvent(_ event: ChromeSocketEvent, connectionID: UUID) async {
        guard self.chromeConnectionID == connectionID else {
            return
        }

        switch event {
        case .closed(let description):
            self.logger.info("[cdp-proxy] Chrome WS closed. \(description)")
            self.handleChromeDisconnect(reason: "closed: \(description)")
        case .error(let description):
            self.logger.error("[cdp-proxy] Chrome WS error: \(description)")
            self.handleChromeDisconnect(reason: "error: \(description)")
        }
    }

    private func handleClientConnection(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter,
        context _: WebSocketRouterContext<BasicWebSocketRequestContext>,
        cdpPort: Int
    ) async throws {
        let client = ClientHandle(
            send: { message in
                switch message {
                case .text(let text):
                    try await outbound.write(.text(text))
                case .binary(let buffer):
                    try await outbound.write(.binary(buffer))
                }
            },
            close: { code, reason in
                try? await outbound.close(code, reason: reason)
            }
        )

        await self.addClient(client)
        let clientID = client.id

        Task {
            await self.prepareClientConnection(for: clientID, cdpPort: cdpPort)
        }

        do {
            var iterator = inbound.makeAsyncIterator()
            while let message = try await iterator.nextMessage(maxSize: self.maxMessageSize) {
                await self.receive(ProxyMessage(message), from: clientID)
            }
            await self.removeClient(id: clientID, reason: "[cdp-proxy] Client disconnected")
        } catch {
            self.logger.error("[cdp-proxy] Client WS error: \(String(describing: error))")
            await self.removeClient(id: clientID, reason: "[cdp-proxy] Client disconnected")
        }
    }

    private static func defaultDiscoverCDPURL(port: Int) async throws -> String {
        let request = HTTPClientRequest(url: "http://127.0.0.1:\(port)/json/version")
        let response = try await HTTPClient.shared.execute(request, timeout: .seconds(5))
        guard response.status == .ok else {
            throw CDPProxyError.discoveryFailed("Unexpected status \(response.status.code) while discovering CDP URL")
        }

        let bodyBuffer = try await response.body.collect(upTo: 1024 * 1024)
        let bodyData = Data(bodyBuffer.readableBytesView)
        let payload = try JSONDecoder().decode(CDPVersionPayload.self, from: bodyData)
        guard !payload.webSocketDebuggerUrl.isEmpty else {
            throw CDPProxyError.discoveryFailed("Missing webSocketDebuggerUrl in /json/version response")
        }
        return payload.webSocketDebuggerUrl
    }

    private static func cdpURL(
        for port: Int,
        using discoverer: @escaping @Sendable (Int) async throws -> String
    ) async throws -> String {
        try await discoverer(port)
    }

    private func handleChromeDisconnect(reason: String, bufferMessage: ProxyMessage? = nil) {
        self.chromeSocket = nil
        self.chromeConnectionID = nil
        self.chromeConnectionTask = nil

        if self.messageBuffer == nil, self.activeClient != nil || bufferMessage != nil {
            self.messageBuffer = []
        }

        if let bufferMessage {
            self.appendBufferedMessage(bufferMessage)
        }

        self.scheduleChromeReconnect(reason: reason)
    }

    private func scheduleChromeReconnect(reason: String) {
        guard self.chromeReconnectTask == nil else {
            return
        }

        guard let cdpPort = self.cdpPort else {
            self.logger.warning("[cdp-proxy] Chrome WS dropped but no CDP port is available for reconnect")
            return
        }

        let delayMs = self.reconnectDelayNanoseconds / 1_000_000
        self.logger.info("[cdp-proxy] Scheduling Chrome WS reconnect in \(delayMs)ms (\(reason))")
        self.chromeReconnectTask = Task { [cdpPort] in
            await self.runChromeReconnectLoop(cdpPort: cdpPort)
        }
    }

    private func runChromeReconnectLoop(cdpPort: Int) async {
        defer {
            self.chromeReconnectTask = nil
        }

        while !Task.isCancelled {
            do {
                try await self.sleep(self.reconnectDelayNanoseconds)
                let freshURL = try await Self.cdpURL(for: cdpPort, using: self.discoverer)
                self.cachedCDPPort = cdpPort
                self.cachedCDPURL = freshURL
                try await self.ensureChromeConnection(url: freshURL)
                self.logger.info("[cdp-proxy] Chrome WS auto-reconnected")
                return
            } catch is CancellationError {
                return
            } catch {
                self.logger.warning("[cdp-proxy] Auto-reconnect failed: \(String(describing: error))")
            }
        }
    }

    private static func defaultChromeConnector(
        url: String,
        maxFrameSize: Int,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) async throws -> ChromeSocketHandle {
        let messagePump = ChromeInboundMessagePump(
            maxBufferedMessages: Self.defaultChromeInboundMessageBufferLimit
        )
        let messagePumpTask = Task {
            await Self.runChromeMessagePump(messagePump, onMessage: onMessage)
        }
        let terminationState = ChromeSocketTerminationState()
        let (socketStream, socketContinuation) = AsyncStream<WebSocket>.makeStream()
        let connectFuture = WebSocket.connect(
            to: url,
            configuration: .init(maxFrameSize: maxFrameSize),
            on: HTTPClient.defaultEventLoopGroup
        ) { socket in
            socket.onText { _, text in
                let result = messagePump.enqueue(.text(text))
                if case .overflow = result,
                   terminationState.markOverflow(
                       reason: "Inbound Chrome frame buffer overflowed (\(Self.defaultChromeInboundMessageBufferLimit) queued messages)"
                   ) {
                    Task {
                        try? await socket.close(code: .messageTooLarge)
                    }
                }
            }
            socket.onBinary { _, buffer in
                let result = messagePump.enqueue(.binary(buffer))
                if case .overflow = result,
                   terminationState.markOverflow(
                       reason: "Inbound Chrome frame buffer overflowed (\(Self.defaultChromeInboundMessageBufferLimit) queued messages)"
                   ) {
                    Task {
                        try? await socket.close(code: .messageTooLarge)
                    }
                }
            }
            socket.onClose.whenComplete { result in
                Task {
                    await Self.handleChromeSocketTermination(
                        messagePump: messagePump,
                        messagePumpTask: messagePumpTask,
                        result: result,
                        closeDescription: "code=\(String(describing: socket.closeCode))",
                        overflowDescription: terminationState.overflowDescriptionSnapshot(),
                        onEvent: onEvent
                    )
                }
            }

            socketContinuation.yield(socket)
            socketContinuation.finish()
        }

        do {
            try await connectFuture.get()
        } catch {
            socketContinuation.finish()
            messagePump.finish()
            _ = await messagePumpTask.value
            throw error
        }

        var iterator = socketStream.makeAsyncIterator()
        guard let socket = await iterator.next() else {
            throw CDPProxyError.discoveryFailed("WebSocket upgrade completed without a Chrome socket")
        }

        return ChromeSocketHandle(
            send: { message in
                switch message {
                case .text(let text):
                    try await socket.send(text)
                case .binary(let buffer):
                    try await socket.send(raw: buffer.readableBytesView, opcode: .binary)
                }
            },
            close: {
                messagePump.finish()
                try? await socket.close(code: .goingAway)
                _ = await messagePumpTask.value
            },
            isOpen: {
                !socket.isClosed
            }
        )
    }
}

extension CDPProxy {
    static func runChromeMessagePump(
        _ messagePump: ChromeInboundMessagePump,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void
    ) async {
        while let message = await messagePump.next() {
            await onMessage(message)
        }
    }

    static func handleChromeSocketTermination(
        messagePump: ChromeInboundMessagePump,
        messagePumpTask: Task<Void, Never>,
        result: Result<Void, Error>,
        closeDescription: String,
        overflowDescription: String?,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) async {
        messagePump.finish()
        _ = await messagePumpTask.value

        if let overflowDescription {
            await onEvent(.error(overflowDescription))
            return
        }

        switch result {
        case .success:
            await onEvent(.closed(closeDescription))
        case .failure(let error):
            await onEvent(.error(String(describing: error)))
        }
    }
}

final class ChromeInboundMessagePump: @unchecked Sendable {
    enum EnqueueResult: Equatable {
        case enqueued
        case overflow
        case terminated
    }

    private enum NextState {
        case message(ProxyMessage)
        case finished
        case wait
    }

    private let maxBufferedMessages: Int
    private let stateQueue = DispatchQueue(label: "slicc.cdp-proxy.chrome-inbound-pump")
    private var buffer: [ProxyMessage] = []
    private var pendingContinuation: CheckedContinuation<ProxyMessage?, Never>?
    private var isFinished = false

    init(maxBufferedMessages: Int = CDPProxy.defaultChromeInboundMessageBufferLimit) {
        self.maxBufferedMessages = max(1, maxBufferedMessages)
    }

    func enqueue(_ message: ProxyMessage) -> EnqueueResult {
        var continuation: CheckedContinuation<ProxyMessage?, Never>?
        let result = self.stateQueue.sync { () -> EnqueueResult in
            guard !self.isFinished else {
                return .terminated
            }

            if let pendingContinuation = self.pendingContinuation {
                self.pendingContinuation = nil
                continuation = pendingContinuation
                return .enqueued
            }

            guard self.buffer.count < self.maxBufferedMessages else {
                self.isFinished = true
                return .overflow
            }

            self.buffer.append(message)
            return .enqueued
        }

        continuation?.resume(returning: message)
        return result
    }

    func next() async -> ProxyMessage? {
        switch self.nextState() {
        case .message(let message):
            return message
        case .finished:
            return nil
        case .wait:
            return await withCheckedContinuation { continuation in
                var nextState: NextState?

                self.stateQueue.sync {
                    if !self.buffer.isEmpty {
                        nextState = .message(self.buffer.removeFirst())
                        return
                    }

                    if self.isFinished {
                        nextState = .finished
                        return
                    }

                    self.pendingContinuation = continuation
                }

                switch nextState {
                case .message(let message):
                    continuation.resume(returning: message)
                case .finished:
                    continuation.resume(returning: nil)
                case .wait, .none:
                    break
                }
            }
        }
    }

    func finish() {
        var continuation: CheckedContinuation<ProxyMessage?, Never>?

        self.stateQueue.sync {
            guard !self.isFinished else {
                return
            }

            self.isFinished = true
            continuation = self.pendingContinuation
            self.pendingContinuation = nil
        }

        continuation?.resume(returning: nil)
    }

    private func nextState() -> NextState {
        self.stateQueue.sync {
            if !self.buffer.isEmpty {
                return .message(self.buffer.removeFirst())
            }

            if self.isFinished {
                return .finished
            }

            return .wait
        }
    }
}

final class ChromeSocketTerminationState: @unchecked Sendable {
    private let lock = NSLock()
    private var overflowDescription: String?

    func markOverflow(reason: String) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }

        guard self.overflowDescription == nil else {
            return false
        }

        self.overflowDescription = reason
        return true
    }

    func overflowDescriptionSnapshot() -> String? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.overflowDescription
    }
}

struct ClientHandle: Sendable {
    let id: UUID
    let send: @Sendable (ProxyMessage) async throws -> Void
    let close: @Sendable (WebSocketErrorCode, String?) async -> Void

    init(
        id: UUID = UUID(),
        send: @escaping @Sendable (ProxyMessage) async throws -> Void,
        close: @escaping @Sendable (WebSocketErrorCode, String?) async -> Void
    ) {
        self.id = id
        self.send = send
        self.close = close
    }
}

struct ChromeSocketHandle: Sendable {
    let send: @Sendable (ProxyMessage) async throws -> Void
    let close: @Sendable () async -> Void
    let isOpen: @Sendable () -> Bool
}

typealias ChromeSocketConnector = @Sendable (
    String,
    @escaping @Sendable (ProxyMessage) async -> Void,
    @escaping @Sendable (ChromeSocketEvent) async -> Void
) async throws -> ChromeSocketHandle

enum ChromeSocketEvent: Sendable {
    case closed(String)
    case error(String)
}

enum ProxyMessage: Sendable {
    case text(String)
    case binary(ByteBuffer)

    init(_ message: WebSocketMessage) {
        switch message {
        case .text(let text):
            self = .text(text)
        case .binary(let buffer):
            self = .binary(buffer)
        }
    }

    var preview: String {
        switch self {
        case .text(let text):
            return String(text.prefix(200))
        case .binary(let buffer):
            return "<binary \(buffer.readableBytes) bytes>"
        }
    }
}

enum CDPProxyError: Error, Sendable, LocalizedError {
    case discoveryFailed(String)

    var errorDescription: String? {
        switch self {
        case .discoveryFailed(let description):
            return description
        }
    }
}

private struct CDPVersionPayload: Decodable, Sendable {
    let webSocketDebuggerUrl: String
}
