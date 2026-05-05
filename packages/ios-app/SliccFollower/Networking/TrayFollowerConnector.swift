import Foundation
import WebRTC

// MARK: - TrayFollowerConnectorDelegate

protocol TrayFollowerConnectorDelegate: AnyObject {
    /// Called when WebRTC data channel is connected and ready.
    func connector(_ connector: TrayFollowerConnector, didConnect channelSend: @escaping (Data) -> Bool)
    /// Called when connection is lost.
    func connectorDidDisconnect(_ connector: TrayFollowerConnector, reason: String)
    /// Called during reconnection attempts.
    func connector(_ connector: TrayFollowerConnector, isReconnecting attempt: Int)
    /// Called when reconnection gave up.
    func connector(_ connector: TrayFollowerConnector, didGiveUp lastError: String)
    /// Called with connection info after attach.
    func connector(_ connector: TrayFollowerConnector, didReceiveInfo trayId: String, participantCount: Int)
    /// Called when a local ICE candidate is generated — send it to the leader via signaling.
    func connector(_ connector: TrayFollowerConnector, didGenerateCandidate candidate: RTCIceCandidate)
    /// Called when data is received over the data channel.
    func connector(_ connector: TrayFollowerConnector, didReceiveData data: Data)
}

// MARK: - TrayFollowerConnectorError

enum TrayFollowerConnectorError: LocalizedError {
    case attachFailed(code: String, message: String)
    case bootstrapFailed(message: String)
    case stopped

    var errorDescription: String? {
        switch self {
        case .attachFailed(let code, let message):
            return "Tray attach failed (\(code)): \(message)"
        case .bootstrapFailed(let message):
            return "Tray bootstrap failed: \(message)"
        case .stopped:
            return "Tray follower connector stopped"
        }
    }
}

// MARK: - TrayFollowerConnector

class TrayFollowerConnector: NSObject {
    let joinUrl: URL

    private var signaling: TraySignalingClient?
    private var webrtc: WebRTCManager?
    private var stopped = false
    private var reconnecting = false
    private var controllerId: String = ""
    /// Current bootstrap ID — used for sending ICE candidates during signaling.
    private var currentBootstrapId: String?
    /// Set once the data-channel-open callback has been delivered to the
    /// delegate so that the polling loop and the WebRTC delegate don't
    /// each fire `didConnect` for the same channel. Reset on tearDown.
    private var didConnectAnnounced: Bool = false

    /// Exponential backoff configuration (mirrors startFollowerWithAutoReconnect).
    var baseDelaySeconds: TimeInterval = 2.0
    var maxDelaySeconds: TimeInterval = 30.0
    var backoffMultiplier: Double = 1.5
    var maxReconnectAttempts: Int = 20
    /// Polling interval for bootstrap events.
    var pollIntervalSeconds: TimeInterval = 1.0

    weak var delegate: TrayFollowerConnectorDelegate?

    init(joinUrl: URL) {
        self.joinUrl = joinUrl
        super.init()
    }

    // MARK: - Start

    /// Start the connection process (signaling → WebRTC → data channel).
    func start() async throws {
        stopped = false
        reconnecting = false
        controllerId = UUID().uuidString
        signaling = TraySignalingClient(joinUrl: joinUrl)

        try await connectOnce()
    }

    // MARK: - Stop / Cancel

    /// Stop and clean up.
    func stop() {
        stopped = true
        reconnecting = false
        tearDown()
    }

    /// Cancel everything (alias for stop).
    func cancel() {
        stop()
    }

    // MARK: - Private — Single connection attempt

    /// Runs the attach loop → bootstrap → data channel open flow once.
    private func connectOnce() async throws {
        guard let signaling = signaling else { return }
        try ensureNotStopped()

        // --- Phase 1: Attach loop ---
        var attachAttempt = 0
        var attachPlan: FollowerAttachPlan!

        while true {
            try ensureNotStopped()
            attachAttempt += 1

            let plan = try await signaling.attach(controllerId: controllerId)

            delegate?.connector(self, didReceiveInfo: plan.trayId, participantCount: plan.participantCount)

            switch plan.action {
            case .wait:
                let retryMs = plan.retryAfterMs ?? 1000
                try await Task.sleep(nanoseconds: UInt64(retryMs) * 1_000_000)
                continue
            case .fail:
                let message = plan.error ?? "Attach failed (\(plan.code))"
                throw TrayFollowerConnectorError.attachFailed(code: plan.code, message: message)
            case .signal:
                attachPlan = plan
            }
            break
        }

        // --- Phase 2: Configure WebRTC with ICE servers ---
        let webrtcManager = WebRTCManager()
        webrtcManager.delegate = self
        self.webrtc = webrtcManager
        didConnectAnnounced = false

        // Always configure: when iceServers is omitted we still need a
        // peerConnection so that handleOffer (Phase 3) doesn't throw
        // notConfigured. An empty server list lets WebRTC fall back to
        // host-only candidates which is fine on a LAN tray.
        webrtcManager.configure(iceServers: attachPlan.iceServers ?? [])

        // --- Phase 3: Bootstrap polling loop ---
        guard let bootstrap = attachPlan.bootstrap else {
            throw TrayFollowerConnectorError.bootstrapFailed(message: "No bootstrap in signal response")
        }

        currentBootstrapId = bootstrap.bootstrapId
        try await completeBootstrap(signaling: signaling, initialBootstrap: bootstrap)
    }

    /// Poll for bootstrap events and process them until the data channel opens.
    private func completeBootstrap(
        signaling: TraySignalingClient,
        initialBootstrap: TrayBootstrapStatus
    ) async throws {
        var currentBootstrap = initialBootstrap
        var cursor: Int? = 0

        while true {
            try ensureNotStopped()

            // Check if data channel is already open
            if webrtc?.isConnected == true {
                // Connected! Provide the send closure.
                let rtc = webrtc!
                let sendClosure: (Data) -> Bool = { data in
                    rtc.sendData(data)
                }
                announceDidConnectIfNeeded(sendClosure)
                return
            }

            let poll = try await signaling.pollBootstrap(
                controllerId: controllerId,
                bootstrapId: currentBootstrap.bootstrapId,
                cursor: cursor
            )
            currentBootstrap = poll.bootstrap
            cursor = currentBootstrap.cursor

            do {
                try await processBootstrapEvents(
                    poll.events,
                    signaling: signaling,
                    bootstrapId: currentBootstrap.bootstrapId
                )
            } catch {
                // Check if retryable
                if let failure = currentBootstrap.failure,
                   failure.retryable,
                   currentBootstrap.retriesRemaining > 0 {
                    let retry = try await signaling.retryBootstrap(
                        controllerId: controllerId,
                        bootstrapId: currentBootstrap.bootstrapId
                    )
                    currentBootstrap = retry.bootstrap
                    cursor = 0

                    // Recreate WebRTC peer
                    webrtc?.close()
                    let newRtc = WebRTCManager()
                    newRtc.delegate = self
                    webrtc = newRtc
                    // ICE servers persist from the original attach response;
                    // the retry response doesn't include new ones.
                    currentBootstrapId = retry.bootstrap.bootstrapId
                    continue
                }
                throw error
            }

            // Not yet connected — wait before next poll
            if webrtc?.isConnected != true {
                try await Task.sleep(nanoseconds: UInt64(pollIntervalSeconds * 1_000_000_000))
            }
        }
    }

    /// Process bootstrap events from a poll response.
    private func processBootstrapEvents(
        _ events: [TrayBootstrapEvent],
        signaling: TraySignalingClient,
        bootstrapId: String
    ) async throws {
        for event in events {
            switch event {
            case .offer(_, _, let offer):
                guard let webrtc = webrtc else { continue }
                let answer = try await webrtc.handleOffer(sdp: offer.sdp)
                // WebRTCManager.handleOffer returns (type: String, sdp: String).
                // Construct the TraySessionDescription expected by the signaling client.
                let answerDesc = TraySessionDescription(type: .answer, sdp: answer.sdp)
                _ = try await signaling.sendAnswer(
                    controllerId: controllerId,
                    bootstrapId: bootstrapId,
                    answer: answerDesc
                )

            case .iceCandidate(_, _, let candidate):
                guard let webrtc = webrtc else { continue }
                try await webrtc.addIceCandidate(
                    candidate: candidate.candidate,
                    sdpMid: candidate.sdpMid,
                    sdpMLineIndex: candidate.sdpMLineIndex.map { Int32($0) }
                )

            case .failed(_, _, let failure):
                throw TrayFollowerConnectorError.bootstrapFailed(message: failure.message)
            }
        }
    }

    // MARK: - Auto-Reconnect (mirrors startFollowerWithAutoReconnect)

    /// Enter the reconnect loop with exponential backoff.
    private func startReconnectLoop(reason: String) {
        guard !stopped, !reconnecting else { return }
        reconnecting = true

        Task { [weak self] in
            await self?.reconnectLoop(initialReason: reason)
        }
    }

    private func reconnectLoop(initialReason: String) async {
        guard !stopped else { return }

        // Tear down old connection
        tearDown()

        var attempt = 0
        var delay = baseDelaySeconds
        var lastError = initialReason

        while !stopped && attempt < maxReconnectAttempts {
            attempt += 1
            delegate?.connector(self, isReconnecting: attempt)

            // Wait before attempting
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                break // Task cancelled
            }

            guard !stopped else { break }

            // Attempt reconnection
            do {
                controllerId = UUID().uuidString
                signaling = TraySignalingClient(joinUrl: joinUrl)
                try await connectOnce()

                // Success — exit reconnect loop
                reconnecting = false
                return
            } catch {
                lastError = error.localizedDescription
                tearDown()
            }

            // Exponential backoff
            delay = min(delay * backoffMultiplier, maxDelaySeconds)
        }

        // Gave up or stopped
        if !stopped {
            reconnecting = false
            delegate?.connector(self, didGiveUp: lastError)
        }
    }

    // MARK: - Helpers

    private func tearDown() {
        webrtc?.close()
        webrtc = nil
        signaling = nil
        didConnectAnnounced = false
    }

    /// Notify the delegate exactly once per connection that the data
    /// channel is ready. Both the bootstrap polling loop and the
    /// `WebRTCManagerDelegate.didOpenDataChannel` callback can race for
    /// this; deduping keeps higher layers from setting up duplicate
    /// message readers and keepalive timers.
    private func announceDidConnectIfNeeded(_ send: @escaping (Data) -> Bool) {
        guard !didConnectAnnounced else { return }
        didConnectAnnounced = true
        delegate?.connector(self, didConnect: send)
    }

    private func ensureNotStopped() throws {
        if stopped {
            throw TrayFollowerConnectorError.stopped
        }
    }
}

// MARK: - WebRTCManagerDelegate

extension TrayFollowerConnector: WebRTCManagerDelegate {
    func webRTCManager(_ manager: WebRTCManager, didOpenDataChannel channel: RTCDataChannel) {
        // Data channel open is handled by the polling loop checking isConnected.
        // But if we're already past the bootstrap phase, notify directly.
        guard !stopped else { return }
        let sendClosure: (Data) -> Bool = { [weak manager] data in
            manager?.sendData(data) ?? false
        }
        announceDidConnectIfNeeded(sendClosure)
    }

    func webRTCManager(_ manager: WebRTCManager, didReceiveMessage data: Data) {
        delegate?.connector(self, didReceiveData: data)
    }

    func webRTCManager(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState) {
        // Connection state monitoring — disconnection triggers reconnect.
    }

    func webRTCManager(_ manager: WebRTCManager, didGenerateLocalCandidate candidate: RTCIceCandidate) {
        delegate?.connector(self, didGenerateCandidate: candidate)

        // Also send the ICE candidate to the leader via signaling.
        guard let signaling = signaling else { return }
        let trayCandidate = TrayIceCandidate(
            candidate: candidate.sdp,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: Int(candidate.sdpMLineIndex),
            usernameFragment: nil
        )
        let bootstrapId = currentBootstrapId ?? ""
        Task { [controllerId] in
            guard !bootstrapId.isEmpty else { return }
            // Fire-and-forget, matching the TS implementation.
            _ = try? await signaling.sendIceCandidate(
                controllerId: controllerId,
                bootstrapId: bootstrapId,
                candidate: trayCandidate
            )
        }
    }

    func webRTCManagerDidDisconnect(_ manager: WebRTCManager, reason: String) {
        guard !stopped else { return }
        delegate?.connectorDidDisconnect(self, reason: reason)
        startReconnectLoop(reason: reason)
    }
}

