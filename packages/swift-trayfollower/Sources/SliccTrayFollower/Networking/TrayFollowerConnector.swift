import Foundation
import WebRTC



public protocol TrayFollowerConnectorDelegate: AnyObject {
    
    func connector(_ connector: TrayFollowerConnector, didConnect channelSend: @escaping (Data) -> Bool)
    
    func connectorDidDisconnect(_ connector: TrayFollowerConnector, reason: String)
    
    func connector(_ connector: TrayFollowerConnector, isReconnecting attempt: Int)
    
    func connector(_ connector: TrayFollowerConnector, didGiveUp lastError: String)
    
    func connector(_ connector: TrayFollowerConnector, didReceiveInfo trayId: String, participantCount: Int)
    
    func connector(_ connector: TrayFollowerConnector, didGenerateCandidate candidate: RTCIceCandidate)
    
    func connector(_ connector: TrayFollowerConnector, didReceiveData data: Data)
}



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



public class TrayFollowerConnector: NSObject {
    
    
    public let joinUrl: URL

    
    
    private var currentJoinUrl: URL

    private var signaling: TraySignalingClient?
    private var webrtc: WebRTCManager?
    private var stopped = false
    private var reconnecting = false
    private var controllerId: String = ""
    
    private var currentBootstrapId: String?
    
    
    
    private var didConnectAnnounced: Bool = false

    
    public var baseDelaySeconds: TimeInterval = 2.0
    public var maxDelaySeconds: TimeInterval = 30.0
    public var backoffMultiplier: Double = 1.5
    public var maxReconnectAttempts: Int = 20
    
    public var pollIntervalSeconds: TimeInterval = 1.0

    public weak var delegate: TrayFollowerConnectorDelegate?

    public init(joinUrl: URL) {
        self.joinUrl = joinUrl
        self.currentJoinUrl = joinUrl
        super.init()
    }

    

    
    public func start() async throws {
        stopped = false
        reconnecting = false
        controllerId = UUID().uuidString
        currentJoinUrl = joinUrl
        signaling = TraySignalingClient(joinUrl: currentJoinUrl)

        try await connectOnce()
    }

    

    
    public func stop() {
        stopped = true
        reconnecting = false
        tearDown()
    }

    
    public func cancel() {
        stop()
    }

    

    
    private func connectOnce() async throws {
        guard var signaling = signaling else { return }
        try ensureNotStopped()

        
        var attachAttempt = 0
        var attachPlan: FollowerAttachPlan!
        var redirectsFollowed = 0

        while true {
            try ensureNotStopped()
            attachAttempt += 1

            let plan = try await signaling.attach(controllerId: controllerId)

            delegate?.connector(self, didReceiveInfo: plan.trayId, participantCount: plan.participantCount)

            
            
            
            
            if plan.supersededByJoinUrl != nil {
                let outcome = SupersedeRedirect.outcome(
                    for: plan, redirectsFollowed: redirectsFollowed)
                guard case .follow(let replacement) = outcome else {
                    let message =
                        SupersedeRedirect.failureMessage(for: outcome)
                        ?? plan.error ?? "Attach failed (\(plan.code))"
                    throw TrayFollowerConnectorError.attachFailed(code: plan.code, message: message)
                }
                redirectsFollowed += 1
                
                
                
                currentJoinUrl = replacement
                controllerId = UUID().uuidString
                signaling = TraySignalingClient(joinUrl: replacement)
                self.signaling = signaling
                try await Task.sleep(
                    nanoseconds: UInt64(SupersedeRedirect.delaySeconds * 1_000_000_000))
                continue
            }

            switch plan.action {
            case .wait:
                let retryMs = plan.retryAfterMs ?? 1000
                try await Task.sleep(nanoseconds: UInt64(retryMs) * 1_000_000)
                continue
            case .fail:
                throw TrayFollowerConnectorError.attachFailed(
                    code: plan.code, message: plan.error ?? "Attach failed (\(plan.code))")
            case .signal:
                attachPlan = plan
            }
            break
        }

        
        let webrtcManager = WebRTCManager()
        webrtcManager.delegate = self
        self.webrtc = webrtcManager
        didConnectAnnounced = false

        
        
        
        
        webrtcManager.configure(iceServers: attachPlan.iceServers ?? [])

        
        guard let bootstrap = attachPlan.bootstrap else {
            throw TrayFollowerConnectorError.bootstrapFailed(message: "No bootstrap in signal response")
        }

        currentBootstrapId = bootstrap.bootstrapId
        try await completeBootstrap(signaling: signaling, initialBootstrap: bootstrap)
    }

    
    private func completeBootstrap(
        signaling: TraySignalingClient,
        initialBootstrap: TrayBootstrapStatus
    ) async throws {
        var currentBootstrap = initialBootstrap
        var cursor: Int? = 0

        while true {
            try ensureNotStopped()

            
            if webrtc?.isConnected == true {
                
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
                
                if let failure = currentBootstrap.failure,
                    failure.retryable,
                    currentBootstrap.retriesRemaining > 0
                {
                    let retry = try await signaling.retryBootstrap(
                        controllerId: controllerId,
                        bootstrapId: currentBootstrap.bootstrapId
                    )
                    currentBootstrap = retry.bootstrap
                    cursor = 0

                    
                    webrtc?.close()
                    let newRtc = WebRTCManager()
                    newRtc.delegate = self
                    webrtc = newRtc
                    
                    
                    currentBootstrapId = retry.bootstrap.bootstrapId
                    continue
                }
                throw error
            }

            
            if webrtc?.isConnected != true {
                try await Task.sleep(nanoseconds: UInt64(pollIntervalSeconds * 1_000_000_000))
            }
        }
    }

    
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

    

    
    private func startReconnectLoop(reason: String) {
        guard !stopped, !reconnecting else { return }
        reconnecting = true

        Task { [weak self] in
            await self?.reconnectLoop(initialReason: reason)
        }
    }

    private func reconnectLoop(initialReason: String) async {
        guard !stopped else { return }

        
        tearDown()

        var attempt = 0
        var delay = baseDelaySeconds
        var lastError = initialReason

        while !stopped && attempt < maxReconnectAttempts {
            attempt += 1
            delegate?.connector(self, isReconnecting: attempt)

            
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                break  
            }

            guard !stopped else { break }

            
            do {
                controllerId = UUID().uuidString
                signaling = TraySignalingClient(joinUrl: currentJoinUrl)
                try await connectOnce()

                
                reconnecting = false
                return
            } catch {
                lastError = error.localizedDescription
                tearDown()
            }

            
            delay = min(delay * backoffMultiplier, maxDelaySeconds)
        }

        
        if !stopped {
            reconnecting = false
            delegate?.connector(self, didGiveUp: lastError)
        }
    }

    

    private func tearDown() {
        webrtc?.close()
        webrtc = nil
        signaling = nil
        didConnectAnnounced = false
    }

    
    
    
    
    
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



extension TrayFollowerConnector: WebRTCManagerDelegate {
    public func webRTCManager(_ manager: WebRTCManager, didOpenDataChannel channel: RTCDataChannel) {
        
        
        guard !stopped else { return }
        let sendClosure: (Data) -> Bool = { [weak manager] data in
            manager?.sendData(data) ?? false
        }
        announceDidConnectIfNeeded(sendClosure)
    }

    public func webRTCManager(_ manager: WebRTCManager, didReceiveMessage data: Data) {
        delegate?.connector(self, didReceiveData: data)
    }

    public func webRTCManager(
        _ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState
    ) {
        
    }

    public func webRTCManager(
        _ manager: WebRTCManager, didGenerateLocalCandidate candidate: RTCIceCandidate
    ) {
        delegate?.connector(self, didGenerateCandidate: candidate)

        
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
            
            _ = try? await signaling.sendIceCandidate(
                controllerId: controllerId,
                bootstrapId: bootstrapId,
                candidate: trayCandidate
            )
        }
    }

    public func webRTCManagerDidDisconnect(_ manager: WebRTCManager, reason: String) {
        guard !stopped else { return }
        delegate?.connectorDidDisconnect(self, reason: reason)
        startReconnectLoop(reason: reason)
    }
}
