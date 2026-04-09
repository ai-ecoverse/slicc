import Foundation
import WebRTC

// MARK: - WebRTCManagerDelegate

protocol WebRTCManagerDelegate: AnyObject {
    func webRTCManager(_ manager: WebRTCManager, didOpenDataChannel channel: RTCDataChannel)
    func webRTCManager(_ manager: WebRTCManager, didReceiveMessage data: Data)
    func webRTCManager(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState)
    func webRTCManager(_ manager: WebRTCManager, didGenerateLocalCandidate candidate: RTCIceCandidate)
    func webRTCManagerDidDisconnect(_ manager: WebRTCManager, reason: String)
}

// MARK: - WebRTCManager

class WebRTCManager: NSObject {
    weak var delegate: WebRTCManagerDelegate?

    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private let factory: RTCPeerConnectionFactory

    /// Whether the data channel is currently open and usable.
    var isConnected: Bool {
        dataChannel?.readyState == .open
    }

    override init() {
        RTCInitializeSSL()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        factory = RTCPeerConnectionFactory(
            encoderFactory: encoderFactory,
            decoderFactory: decoderFactory
        )
        super.init()
    }

    // MARK: - Configuration

    /// Configure ICE servers from TURN credentials and create the peer connection.
    func configure(iceServers: [TurnIceServer]) {
        // Close any existing connection before reconfiguring.
        close()

        let rtcIceServers = iceServers.map { server in
            RTCIceServer(
                urlStrings: server.urls,
                username: server.username,
                credential: server.credential
            )
        }

        let config = RTCConfiguration()
        config.iceServers = rtcIceServers
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: nil
        )

        peerConnection = factory.peerConnection(
            with: config,
            constraints: constraints,
            delegate: self
        )
    }

    // MARK: - Offer / Answer

    /// Handle an SDP offer received from the leader via signaling.
    /// Returns the SDP answer to send back.
    func handleOffer(sdp: String) async throws -> (type: String, sdp: String) {
        guard let pc = peerConnection else {
            throw WebRTCError.notConfigured
        }

        let offerDescription = RTCSessionDescription(type: .offer, sdp: sdp)
        try await pc.setRemoteDescription(offerDescription)

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: nil
        )
        let answer = try await pc.answer(for: constraints)
        try await pc.setLocalDescription(answer)

        return (type: "answer", sdp: answer.sdp)
    }

    // MARK: - ICE Candidates

    /// Add a remote ICE candidate received from the leader.
    func addIceCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int32?) async throws {
        guard let pc = peerConnection else {
            throw WebRTCError.notConfigured
        }

        let iceCandidate = RTCIceCandidate(
            sdp: candidate,
            sdpMLineIndex: sdpMLineIndex ?? 0,
            sdpMid: sdpMid
        )
        try await pc.add(iceCandidate)
    }

    // MARK: - Data Channel

    /// Send raw data over the data channel.
    @discardableResult
    func sendData(_ data: Data) -> Bool {
        guard let channel = dataChannel, channel.readyState == .open else {
            return false
        }
        let buffer = RTCDataBuffer(data: data, isBinary: false)
        return channel.sendData(buffer)
    }

    /// Send a UTF-8 string message over the data channel.
    @discardableResult
    func sendString(_ message: String) -> Bool {
        guard let data = message.data(using: .utf8) else {
            return false
        }
        guard let channel = dataChannel, channel.readyState == .open else {
            return false
        }
        let buffer = RTCDataBuffer(data: data, isBinary: false)
        return channel.sendData(buffer)
    }

    // MARK: - Teardown

    /// Close the peer connection and data channel.
    func close() {
        dataChannel?.close()
        dataChannel = nil
        peerConnection?.close()
        peerConnection = nil
    }

    deinit {
        close()
        RTCCleanupSSL()
    }
}

// MARK: - WebRTCError

enum WebRTCError: LocalizedError {
    case notConfigured

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "WebRTCManager: peer connection not configured. Call configure(iceServers:) first."
        }
    }
}

// MARK: - RTCPeerConnectionDelegate

extension WebRTCManager: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        // No action needed; ICE connection state is more relevant.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        // Data-only connection — no media streams expected.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        // Data-only connection — no media streams expected.
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        // The follower only responds to offers; it never initiates negotiation.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        delegate?.webRTCManager(self, didChangeConnectionState: newState)

        switch newState {
        case .failed:
            delegate?.webRTCManagerDidDisconnect(self, reason: "ICE connection failed")
        case .closed:
            delegate?.webRTCManagerDidDisconnect(self, reason: "ICE connection closed")
        default:
            break
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        // Gathering state changes are informational; candidates are forwarded individually.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        delegate?.webRTCManager(self, didGenerateLocalCandidate: candidate)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {
        // Candidate removal is uncommon and not needed for the tray protocol.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        // The leader creates the data channel; the follower receives it here.
        self.dataChannel = dataChannel
        dataChannel.delegate = self
        delegate?.webRTCManager(self, didOpenDataChannel: dataChannel)
    }
}

// MARK: - RTCDataChannelDelegate

extension WebRTCManager: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        switch dataChannel.readyState {
        case .open:
            delegate?.webRTCManager(self, didOpenDataChannel: dataChannel)
        case .closed:
            delegate?.webRTCManagerDidDisconnect(self, reason: "Data channel closed")
        default:
            break
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        delegate?.webRTCManager(self, didReceiveMessage: buffer.data)
    }
}
