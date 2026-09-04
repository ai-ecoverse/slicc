import Foundation
import Logging

// Extracted from `ElectronLauncher.swift` to keep that file under the
// SwiftLint file-length cap. `OverlayTargetSession` is the per-target CDP
// worker owned by `ElectronOverlayInjector`; the free helpers and types it
// references (`ElectronInspectableTarget`, the overlay timing constants,
// `ElectronOverlayInjector.classifyNetworkEvent`, the egress helpers in
// `ElectronOverlayEgress.swift`) are all module-internal.

// MARK: - OverlayTargetSession

/// Persistent CDP session for one Electron renderer target. Owns the
/// `Page.enable` / `Runtime.enable` / `Page.setBypassCSP` dance, the post-
/// inject iframe probe, and the reload-with-bypass + Fetch-proxy escalation
/// fallback. Mirrors `ElectronOverlayInjector` in
/// `packages/node-server/src/electron-controller.ts` so swift-server reaches
/// parity inside CSP-bearing Electron apps (e.g. AEM Desktop).
final class OverlayTargetSession: @unchecked Sendable {
    private let target: ElectronInspectableTarget
    private let bootstrapScript: String
    /// Status-only overlay bootstrap (no iframe) shown when the app blocks the
    /// overlay's network egress.
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
    /// Set once the app denies the overlay iframe's document request at the
    /// network layer (`Network.loadingFailed` → `net::ERR_ACCESS_DENIED`). The
    /// probe/escalation paths bail out when this is set — no reload, no Fetch
    /// proxy, no bypass record. Mirrors node-server's `ConnectFlowState.egressBlocked`.
    private var egressBlocked = false
    /// CDP `requestId`s of OUR overlay iframe document requests, for correlating
    /// a `Network.loadingFailed` back to the overlay (vs the app's own frames).
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
        // Periodic presence re-check: covers SPAs that re-render their DOM root
        // (evicting the overlay) without firing a navigation event. Cancelled
        // by `stop()` so it never outlives the session.
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

    /// Graceful teardown variant: best-effort sends a Runtime.evaluate that
    /// removes the overlay host element from the document, then calls
    /// `stop()`. Use this on a clean shutdown path so a slicc-server restart
    /// against the same Electron app starts with a fresh DOM. The eval is
    /// fire-and-forget; if the socket is already dead this is a no-op.
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

    // MARK: Connection flow

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
        // Watch the overlay iframe's document request so an app that denies it
        // at the network layer (e.g. Signal → net::ERR_ACCESS_DENIED) is
        // detected and the doomed CSP/Fetch escalation is skipped (see
        // `applyNetworkSignal`).
        _ = await sendCommand(method: "Network.enable", awaitResponse: true)

        // A target already known to block renderer egress cannot load the hosted
        // overlay by any escalation — show the status-only overlay (no iframe)
        // instead of re-running the doomed iframe injection + probe. (The
        // stripped-down CDP-over-CDP follower path drives these apps.)
        if isAlreadyEgressBlocked(target.url) {
            stateQueue.sync { egressBlocked = true }
            logger.info(
                "Target blocks renderer egress — injecting status-only overlay",
                metadata: ["target": .string(target.url)])
            await injectStatusOverlay()
            return
        }

        _ = await sendCommand(method: "Page.setBypassCSP", params: ["enabled": true], awaitResponse: true)
        // Install the bootstrap as a permanent new-document hook so it
        // re-runs automatically after the reload below (and after any
        // additional navigation the host app's own bootstrap may trigger
        // — observed in AEM Desktop where Runtime.evaluate after
        // Page.loadEventFired raced a fresh document and did not stick).
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

    /// Whether the app has denied the overlay iframe's document request at the
    /// network layer (see `applyNetworkSignal`).
    private func isEgressBlockedNow() -> Bool {
        stateQueue.sync { egressBlocked }
    }

    private func handlePostProbe(loaded: Bool) async {
        // Egress-blocked apps deny the overlay's document request beneath the
        // layer setBypassCSP / the Fetch proxy operate at, so escalation cannot
        // help. The probe's throw-based "loaded" can't tell this apart from a
        // real cross-origin load, so `egressBlocked` is authoritative: bail out
        // WITHOUT recording the target as bypassed/loaded.
        if isEgressBlockedNow() { return }
        let decision = ElectronOverlayInjector.postProbeAction(loaded: loaded)
        if ElectronOverlayInjector.shouldRecordBypassedAfter(probeAction: decision) {
            recordBypassed(target.url)
        }
        switch decision {
        case .done:
            logger.info("Overlay iframe loaded successfully — no CSP reload needed", metadata: ["target": .string(target.url)])
        case .reloadWithBypass:
            // Deliberately do NOT recordBypassed yet — if the CDP session
            // disconnects mid-reload (AEM Desktop's bootstrap recreates the
            // execution context, which closes our WS), the next reconnect
            // needs to re-run the reload path. Only record once
            // `handleLoadEventFired` confirms the iframe loaded.
            logger.info("Overlay iframe blocked by CSP, reloading with bypass", metadata: ["target": .string(target.url)])
            stateQueue.sync {
                pendingReload = true
                pendingCspEscalation = true
            }
            _ = await sendCommand(method: "Page.reload", params: ["ignoreCache": true])
        }
    }

    // MARK: Event handling

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
                // Fail all pending continuations and cancel the socket so the
                // `runConnectFlow` (or `handleLoadEventFired`) awaiting a
                // response unblocks instead of hanging forever. The injector's
                // polling loop will then reconnect with a fresh session.
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
            // In-page SPA route change (history.pushState / hashchange) or a
            // main-frame load-driven nav: re-inject the role bootstrap if the
            // host element was evicted. The eviction probe keeps a full
            // main-frame navigation a no-op (its marker is wiped, so the
            // new-document hook owns it).
            if ElectronOverlayInjector.shouldReinjectOnNavigationEvent(method: method, params: params) {
                // Dispatch off the receive loop so it keeps consuming
                // `receive()` and can resolve the eviction probe's CDP response.
                // Awaiting `reinjectIfEvicted` inline here would deadlock: the
                // probe registers a `responseWaiters` continuation that only the
                // receive loop can resolve, so the probe would stall until its
                // command timeout. Mirrors node-server's fire-and-forget
                // `void this.reinjectIfEvicted(...)` from its event handler.
                Task { [weak self] in await self?.reinjectIfEvicted() }
            }
        }
    }

    /// Apply the egress-block signal from a `Network.*` event: track OUR overlay
    /// iframe's document request (matched by the bridge token) and, on a
    /// network-layer denial, mark the target egress-blocked, stop the Network
    /// stream, and record it so escalation is skipped. Mirrors node-server's
    /// `handleNetworkEventForEgressBlock`.
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
            // Determination made — stop the Network event stream for this session.
            _ = await sendCommand(method: "Network.disable")
            if firstTime {
                recordEgressBlocked(target.url)
                let errorText = (params?["errorText"] as? String) ?? "net::ERR_ACCESS_DENIED"
                logger.info(
                    "Overlay blocked by app network egress; hosted overlay cannot load — skipping CSP/Fetch escalation. Egress-blocked apps need the CDP-over-CDP follower path.",
                    metadata: ["target": .string(target.url), "error": .string(errorText)])
                // Replace the (blank-iframe) overlay with the status-only launcher.
                await injectStatusOverlay()
            }
        case .ignore:
            break
        }
    }

    /// Show the status-only overlay (launcher + message, no iframe) on a target
    /// that blocks the embedded panel. Injects the status bootstrap now AND as a
    /// `Page.addScriptToEvaluateOnNewDocument` hook so it survives app reloads
    /// (it runs after the role hook, so the idempotent launcher ends up
    /// status-only). Mirrors node-server's `injectStatusOverlay`.
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
        // Network-egress block detected during/after the reload — the Fetch
        // proxy can't help either (it intercepts above the denying layer), so
        // stop here without re-injecting or recording the target as loaded.
        if isEgressBlockedNow() { return }

        logger.info("Page loaded after CSP-bypass reload, re-injecting overlay", metadata: ["target": .string(target.url)])
        // The CDP session keeps `Page.setBypassCSP` enabled across reloads,
        // but re-arm it defensively to match node-server.
        _ = await sendCommand(method: "Page.setBypassCSP", params: ["enabled": true], awaitResponse: true)
        await sendBootstrap()
        // Read back the global so a "didn't stick" reinject shows up in logs
        // immediately instead of silently failing the second-probe later.
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
        // For file:// (or other no-http-origin) targets, fall back to the
        // overlay iframe's own http origin — Fetch.enable patterns must be
        // http(s) and the iframe is what we ultimately need unblocked.
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

    // MARK: Fetch-proxy escalation

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

        // Only proxy HTML document requests; everything else goes through unchanged.
        guard accept.contains("text/html") else {
            _ = await sendCommand(method: "Fetch.continueRequest", params: ["requestId": requestId])
            return
        }

        // A document POST (a navigating <form>, including multipart with a file)
        // is a byte pipe. Recover the exact bytes or fail — never forward a guess.
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
            // Fire-and-forget to match node-server (electron-controller.ts
            // `send('Fetch.fulfillRequest', ...)` with no await). Awaiting
            // here is what previously tripped the 10s command timeout on
            // every cycle, producing the "CDP command timed out" /
            // "Client disconnected" loop in AEM Desktop.
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
        // Skip headers URLSession owns / hop-by-hop on the request side.
        let stripRequestHeaders: Set<String> = ["content-length", "host", "connection", "keep-alive", "transfer-encoding"]
        for (name, value) in headers where !stripRequestHeaders.contains(name.lowercased()) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        // Raw bytes only. The old `Data(base64Encoded:) ?? .utf8` fallback either
        // mis-read a latin1 body as base64 or UTF-8-expanded it (#2886).
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

    // MARK: Helpers

    private func sendBootstrap() async {
        _ = await sendCommand(
            method: "Runtime.evaluate",
            params: [
                "expression": bootstrapScript,
                "awaitPromise": false,
            ])
    }

    /// Periodic presence re-check loop: every `presenceCheckIntervalNanoseconds`
    /// (after an initial interval, matching node-server's `setInterval` cadence)
    /// re-inject the overlay if it was evicted. Covers SPAs that re-render their
    /// DOM root without firing any navigation event the handler could hook.
    private func runPresenceCheckLoop() async {
        while !Task.isCancelled && !isClosed() {
            try? await Task.sleep(nanoseconds: presenceCheckIntervalNanoseconds)
            if Task.isCancelled || isClosed() { return }
            await reinjectIfEvicted()
        }
    }

    /// Re-inject the overlay if (and only if) it was evicted from this
    /// already-connected target — an in-page SPA route change or DOM-root
    /// re-render that removed `#slicc-electron-overlay-root` while the
    /// `__SLICC_ELECTRON_OVERLAY__` marker persists. Gated on the eviction probe
    /// so it is idempotent and never loops while the host element is still
    /// attached, and skipped while the CSP-bypass reload / Fetch-proxy
    /// escalation owns injection (`pendingReload`). Re-uses this session's
    /// existing role bootstrap, so no leader/follower re-election occurs.
    /// Mirrors node-server's `reinjectIfEvicted`.
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

    /// Evaluate `overlayEvictedProbeExpression()` and resolve `true` only when
    /// the overlay marker is present but the host element is gone — the
    /// SPA-DOM-root eviction case re-injection must repair. Mirrors
    /// node-server's `probeOverlayEvicted`.
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

    /// Install the bootstrap as a `Page.addScriptToEvaluateOnNewDocument`
    /// hook so it re-runs automatically on every new document — including
    /// ones the host app's own bootstrap may create after our reload (the
    /// AEM Desktop case where the re-evaluate after `Page.loadEventFired`
    /// would otherwise race a fresh document and not stick).
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

    /// Read back `window.__SLICC_ELECTRON_OVERLAY__` (and the overlay host)
    /// right after injection so a silently-lost inject (e.g. a stale
    /// execution context the bootstrap script ran in) shows up in the logs
    /// instead of only being detected later by the iframe probe.
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
        // Mirrors node-server's `probeOverlayIframeLoaded`: walks the
        // `<slicc-launcher>` host → (open) shadowRoot → iframe and only reports
        // success when the iframe actually navigated away from `about:blank`.
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
                // Belt-and-suspenders timeout so a wedged CDP call (e.g. the
                // socket silently buffering against a dead peer) cannot stall
                // the connect/post-reload pipeline. The receive-loop's
                // disconnect handler also fails pending waiters via `stop()`,
                // so the timeout is the fallback when no error surfaces.
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

    /// Test-only: register a synthetic pending waiter (no socket I/O) so a
    /// unit test can drive `stop()` and assert the continuation resolves
    /// with `nil`. Verifies the receive-loop disconnect path that previously
    /// hung the connect/post-reload pipeline.
    func _testing_awaitSyntheticWaiter() async -> [String: Any]? {
        await withCheckedContinuation { (cont: CheckedContinuation<[String: Any]?, Never>) in
            stateQueue.sync {
                messageIdCounter += 1
                responseWaiters[messageIdCounter] = cont
            }
        }
    }

    /// Test-only: current count of registered response waiters.
    func _testing_pendingWaiterCount() -> Int {
        stateQueue.sync { responseWaiters.count }
    }

    static func overlayOrigin(for urlString: String) -> String? {
        // Gate on http/https only. `URL` happily parses `app://something/foo`
        // with scheme="app" and host="something", which would key
        // `Fetch.enable` patterns on a non-http origin that CDP cannot
        // intercept. Match node-server (`resolveFetchProxyOrigin`) by falling
        // back to the overlay iframe's `http://localhost:<servePort>` origin
        // for any non-http parent — file://, app://, etc.
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

    /// Resolve the Fetch.enable origin pattern: prefer the parent page's
    /// http origin (matches node-server byte-for-byte), but for file:// (or
    /// other no-http-origin) targets fall back to the overlay iframe's own
    /// `http://localhost:<servePort>` origin so the iframe load is at least
    /// covered by Fetch interception.
    static func fetchProxyOrigin(targetURL: String, servePort: Int) -> String {
        if let origin = overlayOrigin(for: targetURL) {
            return origin
        }
        return "http://localhost:\(servePort)"
    }
}
