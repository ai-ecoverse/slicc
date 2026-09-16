import Foundation
import Logging

final class OverlayTargetSession: @unchecked Sendable {
    private let target: ElectronInspectableTarget
    private let bootstrapScript: String

    private let statusBootstrapScript: String
    private let servePort: Int
    private let bridgeToken: String
    private let urlSession: URLSession
    private let logger: Logger
    private let probeDelayNanoseconds: UInt64
    private let commandTimeoutNanoseconds: UInt64
    private let presenceCheckIntervalNanoseconds: UInt64
    private let isAlreadyBypassed: @Sendable (String) -> Bool
    private let recordBypassed: @Sendable (String) -> Void
    private let isAlreadyEgressBlocked: @Sendable (String) -> Bool
    private let recordEgressBlocked: @Sendable (String) -> Void
    private let onClose: @Sendable (String) -> Void

    private let stateQueue = DispatchQueue(label: "slicc.browser.electron-overlay-session")
    private var socket: URLSessionWebSocketTask?
    private var recvTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var presenceTask: Task<Void, Never>?
    private var messageIdCounter = 0
    private var pendingReload = false
    private var pendingCspEscalation = false
    private var fetchProxyActive = false

    private var egressBlocked = false

    private var overlayRequestIDs = Set<String>()
    private var addedScriptIdentifier: String?
    private var responseWaiters: [Int: CheckedContinuation<[String: Any]?, Never>] = [:]
    private var closed = false

    init(
        target: ElectronInspectableTarget,
        bootstrapScript: String,
        statusBootstrapScript: String,
        servePort: Int,
        bridgeToken: String,
        session: URLSession,
        logger: Logger,
        probeDelayNanoseconds: UInt64,
        commandTimeoutNanoseconds: UInt64 = 10_000_000_000,
        presenceCheckIntervalNanoseconds: UInt64 = electronOverlayPresenceCheckIntervalNanoseconds,
        isAlreadyBypassed: @escaping @Sendable (String) -> Bool,
        recordBypassed: @escaping @Sendable (String) -> Void,
        isAlreadyEgressBlocked: @escaping @Sendable (String) -> Bool,
        recordEgressBlocked: @escaping @Sendable (String) -> Void,
        onClose: @escaping @Sendable (String) -> Void
    ) {
        self.target = target
        self.bootstrapScript = bootstrapScript
        self.statusBootstrapScript = statusBootstrapScript
        self.servePort = servePort
        self.bridgeToken = bridgeToken
        self.urlSession = session
        self.logger = logger
        self.probeDelayNanoseconds = probeDelayNanoseconds
        self.commandTimeoutNanoseconds = commandTimeoutNanoseconds
        self.presenceCheckIntervalNanoseconds = presenceCheckIntervalNanoseconds
        self.isAlreadyBypassed = isAlreadyBypassed
        self.recordBypassed = recordBypassed
        self.isAlreadyEgressBlocked = isAlreadyEgressBlocked
        self.recordEgressBlocked = recordEgressBlocked
        self.onClose = onClose
    }

    func start() {
        guard let urlString = target.webSocketDebuggerURL,
            let url = URL(string: urlString)
        else { return }
        let task = urlSession.webSocketTask(with: url)
        stateQueue.sync { socket = task }
        task.resume()

        let recv = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.runReceiveLoop()
        }
        let connect = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.runConnectFlow()
        }

        let presence = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.runPresenceCheckLoop()
        }
        stateQueue.sync {
            recvTask = recv
            connectTask = connect
            presenceTask = presence
        }
    }

    private struct StopSnapshot {
        let wasAlreadyClosed: Bool
        let socket: URLSessionWebSocketTask?
        let recvTask: Task<Void, Never>?
        let connectTask: Task<Void, Never>?
        let presenceTask: Task<Void, Never>?
        let waiters: [Int: CheckedContinuation<[String: Any]?, Never>]
    }

    func stop() {
        let snapshot: StopSnapshot = stateQueue.sync {
            let was = closed
            closed = true
            let captured = StopSnapshot(
                wasAlreadyClosed: was,
                socket: socket,
                recvTask: recvTask,
                connectTask: connectTask,
                presenceTask: presenceTask,
                waiters: responseWaiters
            )
            socket = nil
            recvTask = nil
            connectTask = nil
            presenceTask = nil
            responseWaiters.removeAll()
            return captured
        }
        if snapshot.wasAlreadyClosed { return }
        for (_, waiter) in snapshot.waiters {
            waiter.resume(returning: nil)
        }
        snapshot.socket?.cancel(with: .goingAway, reason: nil)
        snapshot.recvTask?.cancel()
        snapshot.connectTask?.cancel()
        snapshot.presenceTask?.cancel()
    }

    func gracefulShutdown() async {
        let alreadyClosed = stateQueue.sync { closed }
        if alreadyClosed { return }
        _ = await sendCommand(
            method: "Runtime.evaluate",
            params: [
                "expression": ElectronOverlayInjector.overlayHostRemovalExpression(),
                "awaitPromise": false,
            ])
        stop()
    }

    private func runConnectFlow() async {
        let alreadyBypassed = isAlreadyBypassed(target.url)
        logger.info(
            "Overlay target connection opening",
            metadata: [
                "target": .string(target.url),
                "alreadyBypassed": .stringConvertible(alreadyBypassed),
            ])

        _ = await sendCommand(method: "Runtime.enable", awaitResponse: true)
        _ = await sendCommand(method: "Page.enable", awaitResponse: true)

        _ = await sendCommand(method: "Network.enable", awaitResponse: true)

        if isAlreadyEgressBlocked(target.url) {
            stateQueue.sync { egressBlocked = true }
            logger.info(
                "Target blocks renderer egress — injecting status-only overlay",
                metadata: ["target": .string(target.url)])
            await injectStatusOverlay()
            return
        }

        _ = await sendCommand(method: "Page.setBypassCSP", params: ["enabled": true], awaitResponse: true)

        await registerNewDocumentScript()

        let action = ElectronOverlayInjector.openAction(alreadyCSPBypassed: alreadyBypassed)
        switch action {
        case .injectOnly:
            logger.info("Injecting overlay (CSP already bypassed)", metadata: ["target": .string(target.url)])
            await sendBootstrap()
            _ = await verifyOverlayPresent(context: "inject-only")
        case .injectThenProbe:
            logger.info("Injecting overlay (first attempt)", metadata: ["target": .string(target.url)])
            await sendBootstrap()
            _ = await verifyOverlayPresent(context: "first-inject")
            let loaded = await ElectronOverlayInjector.pollOverlayLoaded(
                budgetNanoseconds: overlayFirstProbeBudgetNanoseconds,
                intervalNanoseconds: overlayFirstProbeIntervalNanoseconds,
                shouldStop: {
                    [weak self] in Task.isCancelled || (self?.isClosed() ?? true) || (self?.isEgressBlockedNow() ?? false)
                },
                probe: { [weak self] in await self?.probeOverlayLoaded() ?? false }
            )
            if Task.isCancelled || isClosed() { return }
            await handlePostProbe(loaded: loaded)
        }
    }

    private func isEgressBlockedNow() -> Bool {
        stateQueue.sync { egressBlocked }
    }

    private func handlePostProbe(loaded: Bool) async {

        if isEgressBlockedNow() { return }
        let decision = ElectronOverlayInjector.postProbeAction(loaded: loaded)
        if ElectronOverlayInjector.shouldRecordBypassedAfter(probeAction: decision) {
            recordBypassed(target.url)
        }
        switch decision {
        case .done:
            logger.info("Overlay iframe loaded successfully — no CSP reload needed", metadata: ["target": .string(target.url)])
        case .reloadWithBypass:

            logger.info("Overlay iframe blocked by CSP, reloading with bypass", metadata: ["target": .string(target.url)])
            stateQueue.sync {
                pendingReload = true
                pendingCspEscalation = true
            }
            _ = await sendCommand(method: "Page.reload", params: ["ignoreCache": true])
        }
    }

    private func runReceiveLoop() async {
        while !Task.isCancelled {
            guard let activeSocket = stateQueue.sync(execute: { socket }) else { return }
            do {
                let message = try await activeSocket.receive()
                guard case .string(let text) = message,
                    let data = text.data(using: .utf8),
                    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else {
                    continue
                }
                if let id = json["id"] as? Int {
                    let waiter: CheckedContinuation<[String: Any]?, Never>? = stateQueue.sync {
                        responseWaiters.removeValue(forKey: id)
                    }
                    waiter?.resume(returning: json["result"] as? [String: Any])
                } else if let method = json["method"] as? String {
                    await handleEvent(method: method, params: json["params"] as? [String: Any])
                }
            } catch {
                if !isClosed() {
                    let pendingCount = stateQueue.sync { responseWaiters.count }
                    logger.warning(
                        "Overlay session disconnected, failing in-flight CDP requests",
                        metadata: [
                            "target": .string(target.url),
                            "error": .string(error.localizedDescription),
                            "pendingWaiters": .stringConvertible(pendingCount),
                        ])
                }
                let targetID = target.webSocketDebuggerURL ?? target.url

                stop()
                onClose(targetID)
                return
            }
        }
    }

    private func handleEvent(method: String, params: [String: Any]?) async {
        switch method {
        case "Page.loadEventFired":
            await handleLoadEventFired()
        case "Fetch.requestPaused":
            await handleFetchRequestPaused(params: params ?? [:])
        case "Network.requestWillBeSent", "Network.loadingFailed":
            await applyNetworkSignal(method: method, params: params)
        default:

            if ElectronOverlayInjector.shouldReinjectOnNavigationEvent(method: method, params: params) {

                Task { [weak self] in await self?.reinjectIfEvicted() }
            }
        }
    }

    private func applyNetworkSignal(method: String, params: [String: Any]?) async {
        let currentIDs = stateQueue.sync { overlayRequestIDs }
        let signal = ElectronOverlayInjector.classifyNetworkEvent(
            method: method,
            params: params,
            bridgeToken: bridgeToken,
            overlayRequestIDs: currentIDs
        )
        switch signal {
        case .trackOverlayRequest(let requestId):
            stateQueue.sync { _ = overlayRequestIDs.insert(requestId) }
        case .egressBlocked:
            let firstTime: Bool = stateQueue.sync {
                let wasBlocked = egressBlocked
                egressBlocked = true
                return !wasBlocked
            }

            _ = await sendCommand(method: "Network.disable")
            if firstTime {
                recordEgressBlocked(target.url)
                let errorText = (params?["errorText"] as? String) ?? "net::ERR_ACCESS_DENIED"
                logger.info(
                    "Overlay blocked by app network egress; hosted overlay cannot load — skipping CSP/Fetch escalation. Egress-blocked apps need the CDP-over-CDP follower path.",
                    metadata: ["target": .string(target.url), "error": .string(errorText)])

                await injectStatusOverlay()
            }
        case .ignore:
            break
        }
    }

    private func injectStatusOverlay() async {
        _ = await sendCommand(
            method: "Page.addScriptToEvaluateOnNewDocument",
            params: ["source": statusBootstrapScript])
        _ = await sendCommand(
            method: "Runtime.evaluate",
            params: ["expression": statusBootstrapScript, "awaitPromise": false])
    }

    private func handleLoadEventFired() async {
        let snapshot: (reload: Bool, escalation: Bool) = stateQueue.sync {
            let r = pendingReload
            let e = pendingCspEscalation
            pendingReload = false
            pendingCspEscalation = false
            return (r, e)
        }
        guard snapshot.reload else { return }

        if isEgressBlockedNow() { return }

        logger.info("Page loaded after CSP-bypass reload, re-injecting overlay", metadata: ["target": .string(target.url)])

        _ = await sendCommand(method: "Page.setBypassCSP", params: ["enabled": true], awaitResponse: true)
        await sendBootstrap()

        _ = await verifyOverlayPresent(context: "post-reload-inject")

        let escalationRequested = snapshot.escalation
        guard escalationRequested else { return }

        try? await Task.sleep(nanoseconds: probeDelayNanoseconds)
        if Task.isCancelled || isClosed() { return }
        if isEgressBlockedNow() { return }
        let loaded = await probeOverlayLoaded()
        if isEgressBlockedNow() { return }
        let decision = ElectronOverlayInjector.postReloadAction(loaded: loaded, escalationRequested: true)
        if ElectronOverlayInjector.shouldRecordBypassedAfter(postReloadAction: decision) {
            recordBypassed(target.url)
        }
        switch decision {
        case .done, .noEscalationRequested:
            logger.info(
                "Overlay iframe loaded successfully after CSP reload — no proxy needed",
                metadata: [
                    "target": .string(target.url),
                    "decision": .string(String(describing: decision)),
                ])
        case .escalateToFetchProxy:
            logger.warning(
                "Overlay iframe still blocked after bypass reload — escalating to Fetch proxy",
                metadata: [
                    "target": .string(target.url)
                ])
            await activateFetchProxy()
        }
    }

    private func activateFetchProxy() async {

        let origin = OverlayTargetSession.fetchProxyOrigin(targetURL: target.url, servePort: servePort)
        logger.warning(
            "CSP reload insufficient, escalating to Fetch proxy",
            metadata: [
                "target": .string(target.url),
                "origin": .string(origin),
            ])
        stateQueue.sync {
            fetchProxyActive = true
            pendingReload = true
        }
        _ = await sendCommand(
            method: "Fetch.enable",
            params: [
                "patterns": [["urlPattern": "\(origin)/*", "requestStage": "Request"]]
            ], awaitResponse: true)
        _ = await sendCommand(method: "Page.reload", params: ["ignoreCache": true])
    }

    private func handleFetchRequestPaused(params: [String: Any]) async {
        let isActive = stateQueue.sync { fetchProxyActive }
        guard isActive else { return }
        guard let requestId = params["requestId"] as? String else {
            logger.warning("Fetch.requestPaused without requestId, skipping")
            return
        }
        let request = params["request"] as? [String: Any] ?? [:]
        let urlString = request["url"] as? String ?? ""
        let method = request["method"] as? String ?? "GET"
        let headers = request["headers"] as? [String: String] ?? [:]
        let accept = headers["Accept"] ?? headers["accept"] ?? ""

        guard accept.contains("text/html") else {
            _ = await sendCommand(method: "Fetch.continueRequest", params: ["requestId": requestId])
            return
        }

        let postBody = decodeCdpRequestPostBody(request: request)
        if case .unrecoverable(let reason) = postBody {
            logger.error(
                "Cannot recover POST body byte-exactly; failing instead of forwarding corrupt bytes",
                metadata: [
                    "url": .string(String(urlString.prefix(80))),
                    "reason": .string(reason),
                ])
            _ = await sendCommand(
                method: "Fetch.failRequest",
                params: ["requestId": requestId, "errorReason": "Failed"])
            return
        }
        let requestBody = postBody.forwardableBytes

        logger.info("Proxying request to strip CSP", metadata: ["url": .string(String(urlString.prefix(80)))])
        do {
            let proxied = try await fetchAndStripCSP(urlString: urlString, method: method, headers: headers, body: requestBody)

            _ = await sendCommand(
                method: "Fetch.fulfillRequest",
                params: [
                    "requestId": requestId,
                    "responseCode": proxied.statusCode,
                    "responseHeaders": proxied.headers,
                    "body": proxied.bodyBase64,
                ])
            if proxied.strippedCSP {
                logger.info("Stripped CSP", metadata: ["url": .string(String(urlString.prefix(80)))])
            }
        } catch {
            logger.error(
                "Fetch-proxy request failed",
                metadata: [
                    "url": .string(String(urlString.prefix(80))),
                    "error": .string(error.localizedDescription),
                ])
            _ = await sendCommand(
                method: "Fetch.failRequest",
                params: [
                    "requestId": requestId,
                    "errorReason": "Failed",
                ])
        }
    }

    private struct ProxiedResponse {
        let statusCode: Int
        let headers: [[String: String]]
        let bodyBase64: String
        let strippedCSP: Bool
    }

    private func fetchAndStripCSP(
        urlString: String,
        method: String,
        headers: [String: String],
        body: Data?
    ) async throws -> ProxiedResponse {
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method

        let stripRequestHeaders: Set<String> = ["content-length", "host", "connection", "keep-alive", "transfer-encoding"]
        for (name, value) in headers where !stripRequestHeaders.contains(name.lowercased()) {
            request.setValue(value, forHTTPHeaderField: name)
        }

        request.httpBody = body

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        let hopByHop: Set<String> = [
            "content-security-policy",
            "content-security-policy-report-only",
            "transfer-encoding",
            "connection",
            "keep-alive",
        ]
        var responseHeaders: [[String: String]] = []
        var strippedCSP = false
        let rawHeaders = http.allHeaderFields as? [String: String] ?? [:]
        for (name, value) in rawHeaders {
            let lower = name.lowercased()
            if lower.contains("content-security-policy") {
                strippedCSP = true
                continue
            }
            if hopByHop.contains(lower) { continue }
            if lower == "content-length" {
                responseHeaders.append(["name": name, "value": String(data.count)])
                continue
            }
            responseHeaders.append(["name": name, "value": value])
        }
        return ProxiedResponse(
            statusCode: http.statusCode,
            headers: responseHeaders,
            bodyBase64: data.base64EncodedString(),
            strippedCSP: strippedCSP
        )
    }

    private func sendBootstrap() async {
        _ = await sendCommand(
            method: "Runtime.evaluate",
            params: [
                "expression": bootstrapScript,
                "awaitPromise": false,
            ])
    }

    private func runPresenceCheckLoop() async {
        while !Task.isCancelled && !isClosed() {
            try? await Task.sleep(nanoseconds: presenceCheckIntervalNanoseconds)
            if Task.isCancelled || isClosed() { return }
            await reinjectIfEvicted()
        }
    }

    private func reinjectIfEvicted() async {
        let before: (closed: Bool, pendingReload: Bool) = stateQueue.sync { (closed, pendingReload) }
        guard
            ElectronOverlayInjector.shouldAttemptEvictionReinject(
                closed: before.closed,
                pendingReload: before.pendingReload
            )
        else { return }
        let evicted = await probeOverlayEvicted()
        let after: (closed: Bool, pendingReload: Bool) = stateQueue.sync { (closed, pendingReload) }
        guard evicted,
            ElectronOverlayInjector.shouldAttemptEvictionReinject(
                closed: after.closed,
                pendingReload: after.pendingReload
            )
        else { return }
        logger.info("Overlay evicted, re-injecting", metadata: ["target": .string(target.url)])
        await sendBootstrap()
    }

    private func probeOverlayEvicted() async -> Bool {
        let result = await sendCommand(
            method: "Runtime.evaluate",
            params: [
                "expression": ElectronOverlayInjector.overlayEvictedProbeExpression(),
                "awaitPromise": false,
                "returnByValue": true,
            ], awaitResponse: true)
        let value = (result?["result"] as? [String: Any])?["value"] as? String ?? ""
        return ElectronOverlayInjector.shouldReinjectForEvictionProbe(value)
    }

    private func registerNewDocumentScript() async {
        let currentIdentifier = stateQueue.sync { addedScriptIdentifier }
        if ElectronOverlayInjector.shouldSkipNewDocumentRegistration(currentIdentifier: currentIdentifier) {
            logger.debug(
                "Overlay bootstrap already registered, skipping",
                metadata: [
                    "target": .string(target.url),
                    "identifier": .string(currentIdentifier ?? ""),
                ])
            return
        }
        let result = await sendCommand(
            method: "Page.addScriptToEvaluateOnNewDocument",
            params: [
                "source": bootstrapScript
            ], awaitResponse: true)
        if let identifier = result?["identifier"] as? String {
            stateQueue.sync { addedScriptIdentifier = identifier }
            logger.debug(
                "Registered new-document overlay bootstrap",
                metadata: [
                    "target": .string(target.url),
                    "identifier": .string(identifier),
                ])
        } else {
            logger.warning(
                "Page.addScriptToEvaluateOnNewDocument returned no identifier",
                metadata: [
                    "target": .string(target.url)
                ])
        }
    }

    @discardableResult
    private func verifyOverlayPresent(context: String) async -> Bool {
        let expression = """
            (function() {
              try {
                var hasGlobal = typeof window.__SLICC_ELECTRON_OVERLAY__ !== 'undefined';
                var hasRoot = !!document.getElementById('slicc-electron-overlay-root');
                return (hasGlobal ? 'g' : '-') + (hasRoot ? 'r' : '-');
              } catch (e) { return 'err:' + String(e); }
            })()
            """
        let result = await sendCommand(
            method: "Runtime.evaluate",
            params: [
                "expression": expression,
                "awaitPromise": false,
                "returnByValue": true,
            ], awaitResponse: true)
        let value = (result?["result"] as? [String: Any])?["value"] as? String ?? ""
        let stuck = value.hasPrefix("g")
        if stuck {
            logger.info(
                "Overlay inject verified present",
                metadata: [
                    "target": .string(target.url),
                    "context": .string(context),
                    "marker": .string(value),
                ])
        } else {
            logger.warning(
                "Overlay inject did NOT take effect — likely stale execution context",
                metadata: [
                    "target": .string(target.url),
                    "context": .string(context),
                    "marker": .string(value),
                ])
        }
        return stuck
    }

    private func probeOverlayLoaded() async -> Bool {

        let expression = ElectronOverlayInjector.overlayLoadedProbeExpression()
        let result = await sendCommand(
            method: "Runtime.evaluate",
            params: [
                "expression": expression,
                "awaitPromise": false,
                "returnByValue": true,
            ], awaitResponse: true)
        if let inner = result?["result"] as? [String: Any],
            let value = inner["value"] as? String
        {
            return value == "ok"
        }
        return false
    }

    @discardableResult
    private func sendCommand(method: String, params: [String: Any]? = nil, awaitResponse: Bool = false) async -> [String: Any]? {
        let id: Int = stateQueue.sync {
            messageIdCounter += 1
            return messageIdCounter
        }
        var msg: [String: Any] = ["id": id, "method": method]
        if let params { msg["params"] = params }

        if awaitResponse {
            return await withCheckedContinuation { (cont: CheckedContinuation<[String: Any]?, Never>) in
                let activeSocket: URLSessionWebSocketTask? = stateQueue.sync {
                    if closed { return nil }
                    responseWaiters[id] = cont
                    return socket
                }
                guard let activeSocket else {
                    cont.resume(returning: nil)
                    return
                }

                let timeoutNs = self.commandTimeoutNanoseconds
                let methodName = method
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: timeoutNs)
                    guard let self else { return }
                    let waiter: CheckedContinuation<[String: Any]?, Never>? = self.stateQueue.sync {
                        self.responseWaiters.removeValue(forKey: id)
                    }
                    if let waiter {
                        self.logger.warning(
                            "CDP command timed out, failing waiter",
                            metadata: [
                                "target": .string(self.target.url),
                                "method": .string(methodName),
                                "id": .stringConvertible(id),
                            ])
                        waiter.resume(returning: nil)
                    }
                }
                Task { [weak self] in
                    do {
                        let data = try JSONSerialization.data(withJSONObject: msg)
                        guard let text = String(data: data, encoding: .utf8) else {
                            throw CocoaError(.coderInvalidValue)
                        }
                        try await activeSocket.send(.string(text))
                    } catch {
                        guard let self else { return }
                        let waiter: CheckedContinuation<[String: Any]?, Never>? = self.stateQueue.sync {
                            self.responseWaiters.removeValue(forKey: id)
                        }
                        waiter?.resume(returning: nil)
                    }
                }
            }
        } else {
            guard let activeSocket = stateQueue.sync(execute: { socket }) else { return nil }
            do {
                let data = try JSONSerialization.data(withJSONObject: msg)
                if let text = String(data: data, encoding: .utf8) {
                    try await activeSocket.send(.string(text))
                }
            } catch {
                logger.debug(
                    "Failed to send CDP command",
                    metadata: [
                        "method": .string(method),
                        "error": .string(error.localizedDescription),
                    ])
            }
            return nil
        }
    }

    private func isClosed() -> Bool {
        stateQueue.sync { closed }
    }

    func _testing_awaitSyntheticWaiter() async -> [String: Any]? {
        await withCheckedContinuation { (cont: CheckedContinuation<[String: Any]?, Never>) in
            stateQueue.sync {
                messageIdCounter += 1
                responseWaiters[messageIdCounter] = cont
            }
        }
    }

    func _testing_pendingWaiterCount() -> Int {
        stateQueue.sync { responseWaiters.count }
    }

    static func overlayOrigin(for urlString: String) -> String? {

        guard let url = URL(string: urlString),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = url.host
        else {
            return nil
        }
        if let port = url.port { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    static func fetchProxyOrigin(targetURL: String, servePort: Int) -> String {
        if let origin = overlayOrigin(for: targetURL) {
            return origin
        }
        return "http://localhost:\(servePort)"
    }
}
