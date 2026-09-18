import Foundation
import WebRTC



public protocol WebRTCManagerDelegate: AnyObject {
    func webRTCManager(_ manager: WebRTCManager, didOpenDataChannel channel: RTCDataChannel)
    func webRTCManager(_ manager: WebRTCManager, didReceiveMessage data: Data)
    func webRTCManager(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState)
    func webRTCManager(_ manager: WebRTCManager, didGenerateLocalCandidate candidate: RTCIceCandidate)
    func webRTCManagerDidDisconnect(_ manager: WebRTCManager, reason: String)
}



public class WebRTCManager: NSObject {
    public weak var delegate: WebRTCManagerDelegate?

    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var dataChannelOpenAnnounced: Bool = false
    private let factory: RTCPeerConnectionFactory

    
    public var isConnected: Bool {
        dataChannel?.readyState == .open
    }

    
    
    public var bufferedAmount: UInt64 {
        dataChannel?.bufferedAmount ?? 0
    }

    public override init() {
        RTCInitializeSSL()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        factory = RTCPeerConnectionFactory(
            encoderFactory: encoderFactory,
            decoderFactory: decoderFactory
        )
        super.init()
    }

    

    
    public func configure(iceServers: [TurnIceServer]) {
        
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

    

    
    
    public func handleOffer(sdp: String) async throws -> (type: String, sdp: String) {
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

    

    
    public func addIceCandidate(
        candidate: String, sdpMid: String?, sdpMLineIndex: Int32?
    ) async throws {
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

    

    
    @discardableResult
    public func sendData(_ data: Data) -> Bool {
        guard let channel = dataChannel, channel.readyState == .open else {
            return false
        }
        let buffer = RTCDataBuffer(data: data, isBinary: false)
        return channel.sendData(buffer)
    }

    
    @discardableResult
    public func sendString(_ message: String) -> Bool {
        guard let data = message.data(using: .utf8) else {
            return false
        }
        guard let channel = dataChannel, channel.readyState == .open else {
            return false
        }
        let buffer = RTCDataBuffer(data: data, isBinary: false)
        return channel.sendData(buffer)
    }

    

    
    public func close() {
        dataChannel?.close()
        dataChannel = nil
        dataChannelOpenAnnounced = false
        peerConnection?.close()
        peerConnection = nil
    }

    
    
    
    
    
    
    private func announceDataChannelOpenIfNeeded(_ channel: RTCDataChannel) {
        guard !dataChannelOpenAnnounced else { return }
        dataChannelOpenAnnounced = true
        delegate?.webRTCManager(self, didOpenDataChannel: channel)
    }

    deinit {
        close()
        RTCCleanupSSL()
    }
}



enum WebRTCError: LocalizedError {
    case notConfigured

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "WebRTCManager: peer connection not configured. Call configure(iceServers:) first."
        }
    }
}



extension WebRTCManager: RTCPeerConnectionDelegate {
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        
    }

    public func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
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

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        delegate?.webRTCManager(self, didGenerateLocalCandidate: candidate)
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {
        
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        
        self.dataChannel = dataChannel
        dataChannelOpenAnnounced = false
        dataChannel.delegate = self
        if dataChannel.readyState == .open {
            announceDataChannelOpenIfNeeded(dataChannel)
        }
        
    }
}



extension WebRTCManager: RTCDataChannelDelegate {
    public func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        switch dataChannel.readyState {
        case .open:
            announceDataChannelOpenIfNeeded(dataChannel)
        case .closed:
            delegate?.webRTCManagerDidDisconnect(self, reason: "Data channel closed")
        default:
            break
        }
    }

    public func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        delegate?.webRTCManager(self, didReceiveMessage: buffer.data)
    }
}
