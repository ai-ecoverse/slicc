import Foundation
import Logging
import SliccTrayFollower
import WebRTC

// Swift port of node-server's `electron-tray-follower.ts`. A normal SLICC
// follower runs the webapp in the target's renderer and joins the tray over
// WebRTC; Signal blocks renderer egress, so the webapp can't run there — but
// slicc-server has network AND the app's raw CDP. This makes the SERVER the
// follower: it joins the tray (HTTP signalling), answers the leader's WebRTC
// offer, opens the `tray-control` data channel, and runs the tray-sync protocol
// over it — servicing the leader's `cdp.request`s against the app's raw CDP via
// `FederatedCDPServicer`.
//
// The signalling + WebRTC + data-channel + supersede-redirect machinery is the
// shared `TrayFollowerConnector` from `SliccTrayFollower` (also used by the iOS
// app), so this file only layers the CDP servicing on top of its
// `didConnect` / `didReceiveData` surface.

/// Runtime tag advertised on `hello`. Mirrors node's `FOLLOWER_RUNTIME_TAG`.
let electronFollowerRuntimeTag = "slicc-electron"

/// Ties the shared tray-follower transport to the federated-CDP servicer for a
/// single egress-blocked Electron app. `startIfNeeded()` is idempotent so the
/// egress-block detector can fire it once per attach without double-joining.
final class ElectronTrayFollower: NSObject, @unchecked Sendable {
    private let cdpPort: Int
    private let joinURL: URL
    private let runtimeId = UUID().uuidString
    private let logger: Logger
    private let urlSession: URLSession
    private let connector: TrayFollowerConnector

    private let lock = NSLock()
    private var started = false
    private var stopped = false
    private var servicer: FederatedCDPServicer?
    private var channelSend: ((Data) -> Bool)?
    private var reassembler = TrayChunkReassembler()
    private let encoder = JSONEncoder()

    init(cdpPort: Int, joinURL: URL, logger: Logger, session: URLSession = .shared) {
        self.cdpPort = cdpPort
        self.joinURL = joinURL
        self.logger = logger
        self.urlSession = session
        self.connector = TrayFollowerConnector(joinUrl: joinURL)
        super.init()
    }

    /// Start the follower once. Safe to call repeatedly (e.g. from a per-target
    /// egress-block detector); only the first call launches the join flow.
    func startIfNeeded() {
        let shouldStart: Bool = lock.withLock {
            guard !started, !stopped else { return false }
            started = true
            return true
        }
        guard shouldStart else { return }
        logger.info(
            "Electron app blocks overlay egress — starting headless CDP-over-CDP follower",
            metadata: ["cdpPort": .stringConvertible(cdpPort)])
        Task { [weak self] in await self?.run() }
    }

    /// Stop the follower and release the tray + CDP connections.
    func stop() {
        let toStop: FederatedCDPServicer? = lock.withLock {
            stopped = true
            let servicer = self.servicer
            self.servicer = nil
            self.channelSend = nil
            return servicer
        }
        connector.stop()
        if let toStop = toStop {
            Task { await toStop.stop() }
        }
    }

    private func run() async {
        guard let browserWsURL = await resolveBrowserWebSocketURL() else {
            logger.error("Could not resolve the app's browser CDP endpoint; follower not started")
            return
        }
        logger.info("Follower resolved app browser CDP: \(browserWsURL.absoluteString)")
        let servicer = FederatedCDPServicer(
            runtimeId: runtimeId,
            logger: logger,
            send: { [weak self] message in self?.sendToLeader(message) })
        await servicer.connect(browserWsUrl: browserWsURL)
        let cancelled: Bool = lock.withLock {
            guard !stopped else { return true }
            self.servicer = servicer
            return false
        }
        if cancelled {
            await servicer.stop()
            return
        }
        connector.delegate = self
        do {
            try await connector.start()
        } catch {
            logger.error("Tray follower connector failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Endpoint discovery

    /// Resolve the app's browser-level CDP debugger websocket from
    /// `/json/version` (`webSocketDebuggerUrl`).
    private func resolveBrowserWebSocketURL() async -> URL? {
        guard let versionURL = URL(string: "http://127.0.0.1:\(cdpPort)/json/version") else {
            return nil
        }
        do {
            // Explicit per-request timeout: URLSession's default only measures
            // inactivity (60 s), so a CDP endpoint that connects but never sends
            // bytes would stall `startIfNeeded` for a full minute. Parity with
            // the node follower's AbortSignal timeouts.
            var request = URLRequest(url: versionURL)
            request.timeoutInterval = 5
            let (data, _) = try await urlSession.data(for: request)
            return Self.parseBrowserWebSocketURL(from: data)
        } catch {
            logger.error("Failed to read /json/version: \(error.localizedDescription)")
            return nil
        }
    }

    /// Enumerate the app's inspectable targets from `/json/list`.
    private func listTargets() async -> [FederatedCdpInspectableTarget] {
        guard let listURL = URL(string: "http://127.0.0.1:\(cdpPort)/json/list") else { return [] }
        do {
            var request = URLRequest(url: listURL)
            request.timeoutInterval = 5
            let (data, _) = try await urlSession.data(for: request)
            return Self.parseInspectableTargets(from: data)
        } catch {
            logger.error("Failed to read /json/list: \(error.localizedDescription)")
            return []
        }
    }

    /// Parse `webSocketDebuggerUrl` out of a `/json/version` body. Pure so the
    /// endpoint decoding is unit-testable without a live browser.
    static func parseBrowserWebSocketURL(from data: Data) -> URL? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let wsURLString = object["webSocketDebuggerUrl"] as? String
        else { return nil }
        return URL(string: wsURLString)
    }

    /// Parse a `/json/list` body into inspectable targets. Pure + testable.
    static func parseInspectableTargets(from data: Data) -> [FederatedCdpInspectableTarget] {
        guard let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return array.compactMap { entry in
            guard let id = entry["id"] as? String,
                let type = entry["type"] as? String,
                let url = entry["url"] as? String
            else { return nil }
            return FederatedCdpInspectableTarget(
                id: id, type: type, title: entry["title"] as? String, url: url)
        }
    }

    // MARK: - Send / dispatch

    private func sendToLeader(_ message: FollowerToLeaderMessage) {
        let send: ((Data) -> Bool)? = lock.withLock { channelSend }
        guard let send = send, let data = try? encoder.encode(message) else { return }
        _ = send(data)
    }

    /// Route one already-reassembled inbound message. Ping is auto-answered;
    /// `cdp.request` is serviced by the federated-CDP servicer. Exposed for tests.
    func route(_ message: LeaderToFollowerMessage) {
        switch message {
        case .ping:
            sendToLeader(.pong)
        case .cdpRequest(let requestId, _, let method, let params, let sessionId):
            let servicer: FederatedCDPServicer? = lock.withLock { self.servicer }
            let paramsObject = params?.value as? [String: Any]
            Task {
                await servicer?.handleCdpRequest(
                    requestId: requestId, method: method, params: paramsObject, sessionId: sessionId)
            }
        default:
            return
        }
    }

    /// Reassemble transport chunk frames, then decode + route the message.
    /// Mirrors the iOS `AppState.handleDataChannelMessage` two-layer decode.
    func dispatchInbound(_ data: Data) {
        if let frame = try? JSONDecoder().decode(TrayChunkFrame.self, from: data),
            frame.type == TrayChunkFrame.typeTag
        {
            let outcome = lock.withLock { reassembler.accept(frame) }
            guard let message = outcome.message else { return }
            decodeAndRoute(message)
            return
        }
        decodeAndRoute(data)
    }

    private func decodeAndRoute(_ data: Data) {
        guard let message = try? JSONDecoder().decode(LeaderToFollowerMessage.self, from: data) else {
            return
        }
        route(message)
    }

    /// Test seam: install a data-channel send sink without a live WebRTC channel
    /// so `route` / `dispatchInbound` can be exercised in unit tests.
    func _testing_installChannelSend(_ send: @escaping (Data) -> Bool) {
        lock.withLock { channelSend = send }
    }
}

// MARK: - TrayFollowerConnectorDelegate

extension ElectronTrayFollower: TrayFollowerConnectorDelegate {
    func connector(_ connector: TrayFollowerConnector, didConnect channelSend: @escaping (Data) -> Bool) {
        lock.withLock { self.channelSend = channelSend }
        logger.info("Follower tray-control channel open — sent hello, advertising targets")
        // Both sides send `hello` first on channel open; then advertise targets.
        sendToLeader(
            .hello(
                protocolVersion: traySyncProtocolVersion, runtime: electronFollowerRuntimeTag,
                capabilities: nil, motd: nil))
        Task { [weak self] in
            guard let self = self else { return }
            let targets = await self.listTargets()
            self.logger.info("Follower advertising \(targets.count) target(s) to leader")
            let servicer: FederatedCDPServicer? = self.lock.withLock { self.servicer }
            await servicer?.advertiseTargets(targets)
        }
    }

    func connectorDidDisconnect(_ connector: TrayFollowerConnector, reason: String) {
        lock.withLock { channelSend = nil }
        logger.info("Tray follower disconnected: \(reason)")
    }

    func connector(_ connector: TrayFollowerConnector, isReconnecting attempt: Int) {
        logger.info("Tray follower reconnecting (attempt \(attempt))")
    }

    func connector(_ connector: TrayFollowerConnector, didGiveUp lastError: String) {
        logger.error("Tray follower gave up reconnecting: \(lastError)")
    }

    func connector(
        _ connector: TrayFollowerConnector, didReceiveInfo trayId: String, participantCount: Int
    ) {
        logger.debug("Tray follower attached (tray=\(trayId), participants=\(participantCount))")
    }

    func connector(_ connector: TrayFollowerConnector, didGenerateCandidate candidate: RTCIceCandidate) {
        // The connector already relays local ICE candidates to the leader via
        // signalling; nothing to do here.
    }

    func connector(_ connector: TrayFollowerConnector, didReceiveData data: Data) {
        dispatchInbound(data)
    }
}
