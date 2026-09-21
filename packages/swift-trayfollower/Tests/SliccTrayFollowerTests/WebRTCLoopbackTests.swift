import Foundation
import WebRTC
import XCTest

@testable import SliccTrayFollower

/// A process-local leader peer: creates the data channel and offer, then
/// answers ICE from a live `WebRTCManager`. No TURN, host candidates only.
final class LoopbackLeader: NSObject {
    private let factory: RTCPeerConnectionFactory
    private var peerConnection: RTCPeerConnection!
    private var channel: RTCDataChannel!
    private var remoteDescriptionSet = false
    private var pendingRemoteCandidates: [RTCIceCandidate] = []
    private let lock = NSLock()

    private(set) var localCandidates: [RTCIceCandidate] = []
    var onLocalCandidate: ((RTCIceCandidate) -> Void)?
    var onMessage: ((Data) -> Void)?
    var onOpen: (() -> Void)?

    override init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory())
        super.init()
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard
            let pc = factory.peerConnection(
                with: config, constraints: constraints, delegate: self)
        else {
            preconditionFailure("RTCPeerConnectionFactory failed to create a peer connection")
        }
        peerConnection = pc
        let channelConfig = RTCDataChannelConfiguration()
        channelConfig.isOrdered = true
        guard let dataChannel = pc.dataChannel(forLabel: "slicc", configuration: channelConfig)
        else {
            preconditionFailure("failed to create the leader data channel")
        }
        channel = dataChannel
        channel.delegate = self
    }

    func makeOffer() async throws -> String {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let offer = try await peerConnection.offer(for: constraints)
        try await peerConnection.setLocalDescription(offer)
        for _ in 0..<40 where localCandidates.isEmpty {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        return peerConnection.localDescription?.sdp ?? offer.sdp
    }

    func acceptAnswer(_ sdp: String) async throws {
        try await peerConnection.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp))
        lock.lock()
        remoteDescriptionSet = true
        let queued = pendingRemoteCandidates
        pendingRemoteCandidates.removeAll()
        lock.unlock()
        for candidate in queued {
            try await peerConnection.add(candidate)
        }
    }

    func addIceCandidate(_ candidate: RTCIceCandidate) async throws {
        lock.lock()
        let ready = remoteDescriptionSet
        if !ready { pendingRemoteCandidates.append(candidate) }
        lock.unlock()
        if ready { try await peerConnection.add(candidate) }
    }

    @discardableResult
    func send(_ data: Data) -> Bool {
        channel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    func close() {
        channel.close()
        peerConnection.close()
    }
}

extension LoopbackLeader: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        lock.lock()
        localCandidates.append(candidate)
        lock.unlock()
        onLocalCandidate?(candidate)
    }
}

extension LoopbackLeader: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        if dataChannel.readyState == .open { onOpen?() }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        onMessage?(buffer.data)
    }
}

final class RecordingWebRTCDelegate: NSObject, WebRTCManagerDelegate {
    let opened = XCTestExpectation(description: "follower data channel opened")
    let received = XCTestExpectation(description: "follower received a message")
    let disconnected = XCTestExpectation(description: "follower disconnected")
    private let lock = NSLock()
    private(set) var messages: [Data] = []
    private(set) var disconnectReasons: [String] = []
    var onLocalCandidate: ((RTCIceCandidate) -> Void)?

    func webRTCManager(_ manager: WebRTCManager, didOpenDataChannel channel: RTCDataChannel) {
        opened.fulfill()
    }

    func webRTCManager(_ manager: WebRTCManager, didReceiveMessage data: Data) {
        lock.lock()
        messages.append(data)
        lock.unlock()
        received.fulfill()
    }

    func webRTCManager(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState) {}

    func webRTCManager(_ manager: WebRTCManager, didGenerateLocalCandidate candidate: RTCIceCandidate) {
        onLocalCandidate?(candidate)
    }

    func webRTCManagerDidDisconnect(_ manager: WebRTCManager, reason: String) {
        lock.lock()
        disconnectReasons.append(reason)
        lock.unlock()
        disconnected.fulfill()
    }
}

final class WebRTCLoopbackTests: XCTestCase {
    func testHandleOfferWithoutConfigureFails() async {
        let manager = WebRTCManager()
        do {
            _ = try await manager.handleOffer(sdp: "v=0\r\n")
            XCTFail("expected notConfigured")
        } catch let error as WebRTCError {
            XCTAssertEqual(error, .notConfigured)
            XCTAssertTrue(error.errorDescription?.contains("not configured") == true)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertFalse(manager.isConnected)
        XCTAssertEqual(manager.bufferedAmount, 0)
        XCTAssertFalse(manager.sendData(Data("x".utf8)))
        XCTAssertFalse(manager.sendString("x"))
        manager.close()
    }

    func testLiveLoopbackOpensADataChannelAndEchoesBytes() async throws {
        let leader = LoopbackLeader()
        defer { leader.close() }
        let follower = WebRTCManager()
        let delegate = RecordingWebRTCDelegate()
        follower.delegate = delegate
        follower.configure(
            iceServers: [
                TurnIceServer(
                    urls: ["stun:stun.l.google.com:19302"], username: "", credential: "")
            ])

        var followerReady = false
        var pendingForFollower: [RTCIceCandidate] = []
        leader.onLocalCandidate = { candidate in
            if followerReady {
                Task {
                    try? await follower.addIceCandidate(
                        candidate: candidate.sdp,
                        sdpMid: candidate.sdpMid,
                        sdpMLineIndex: candidate.sdpMLineIndex)
                }
            } else {
                pendingForFollower.append(candidate)
            }
        }
        delegate.onLocalCandidate = { candidate in
            Task { try? await leader.addIceCandidate(candidate) }
        }

        let offer = try await leader.makeOffer()
        let answer = try await follower.handleOffer(sdp: offer)
        XCTAssertEqual(answer.type, "answer")
        followerReady = true
        for candidate in pendingForFollower {
            try await follower.addIceCandidate(
                candidate: candidate.sdp,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: candidate.sdpMLineIndex)
        }
        try await leader.acceptAnswer(answer.sdp)

        let leaderOpen = expectation(description: "leader data channel opened")
        leaderOpen.assertForOverFulfill = false
        leader.onOpen = { leaderOpen.fulfill() }
        await fulfillment(of: [delegate.opened, leaderOpen], timeout: 15)
        XCTAssertTrue(follower.isConnected)

        let ping = Data("ping-from-leader".utf8)
        XCTAssertTrue(leader.send(ping), "leader send should succeed once the channel is open")
        await fulfillment(of: [delegate.received], timeout: 5)
        XCTAssertEqual(delegate.messages, [ping])

        let pong = Data("pong-from-follower".utf8)
        let leaderGotPong = expectation(description: "leader received pong")
        leaderGotPong.assertForOverFulfill = false
        var leaderMessages: [Data] = []
        let messageLock = NSLock()
        leader.onMessage = { data in
            messageLock.lock()
            leaderMessages.append(data)
            messageLock.unlock()
            if data == pong { leaderGotPong.fulfill() }
        }
        XCTAssertTrue(follower.sendData(pong), "follower sendData should succeed once connected")
        await fulfillment(of: [leaderGotPong], timeout: 5)
        XCTAssertTrue(leaderMessages.contains(pong))
        XCTAssertTrue(follower.sendString("utf8"))

        follower.configure(iceServers: [])
        XCTAssertFalse(follower.isConnected)
        follower.close()
    }
}
