import Foundation
import WebRTC
import XCTest

@testable import SliccTrayFollower

/// In-process tray hub: JSON attach/poll/answer/ICE over the signaling
/// `Transport` seam, driving a live `LoopbackLeader` WebRTC peer.
final class LoopbackTrayHub: @unchecked Sendable {
    let leader = LoopbackLeader()
    let joinUrl = URL(string: "https://tray.example/join/live-webrtc")!
    private let lock = NSLock()
    private var offerSDP: String?
    private var offerSent = false
    private var queuedCandidates: [TrayIceCandidate] = []
    private var cursor = 0
    private let bootstrapId = "boot-live"
    private let trayId = "tray-live"

    func prepare() async throws {
        let sdp = try await leader.makeOffer()
        lock.lock()
        offerSDP = sdp
        lock.unlock()
        leader.onLocalCandidate = { [weak self] candidate in
            self?.enqueue(candidate)
        }
        for candidate in leader.snapshotLocalCandidates() { enqueue(candidate) }
    }

    func close() { leader.close() }

    var transport: TraySignalingClient.Transport {
        { [joinUrl] request in
            let body =
                (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()))
                as? [String: Any] ?? [:]
            let action = body["action"] as? String
            let data: Data
            if action == nil {
                data = try self.attachResponse(controllerId: body["controllerId"] as? String ?? "c")
            } else {
                data = try await self.bootstrapResponse(action: action ?? "poll", body: body)
            }
            let response = HTTPURLResponse(
                url: request.url ?? joinUrl, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"])!
            return (data, response)
        }
    }

    private func enqueue(_ candidate: RTCIceCandidate) {
        lock.lock()
        queuedCandidates.append(
            TrayIceCandidate(
                candidate: candidate.sdp,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: Int(candidate.sdpMLineIndex),
                usernameFragment: nil))
        lock.unlock()
    }

    private func bootstrapStatus(controllerId: String, state: TrayBootstrapState) -> TrayBootstrapStatus {
        TrayBootstrapStatus(
            controllerId: controllerId,
            bootstrapId: bootstrapId,
            attempt: 1,
            state: state,
            expiresAt: "2099-01-01T00:00:00.000Z",
            cursor: cursor,
            maxRetries: 3,
            retriesRemaining: 3,
            retryAfterMs: nil,
            failure: nil)
    }

    private func attachResponse(controllerId: String) throws -> Data {
        let status = bootstrapStatus(controllerId: controllerId, state: .offered)
        let payload: [String: Any] = [
            "trayId": trayId,
            "controllerId": controllerId,
            "role": "follower",
            "leader": ["controllerId": "leader", "connected": true],
            "participantCount": 2,
            "result": [
                "action": "signal",
                "code": "LEADER_CONNECTED",
                "bootstrap": try jsonObject(status),
            ],
            "iceServers": [
                [
                    "urls": ["stun:stun.l.google.com:19302"],
                    "username": "",
                    "credential": "",
                ]
            ],
        ]
        return try JSONSerialization.data(withJSONObject: payload)
    }

    private func bootstrapResponse(action: String, body: [String: Any]) async throws -> Data {
        let controllerId = body["controllerId"] as? String ?? "c"
        if action == "answer" {
            let answer = body["answer"] as? [String: Any]
            if let sdp = answer?["sdp"] as? String {
                try await leader.acceptAnswer(sdp)
            }
        }
        if action == "ice-candidate" {
            let raw = body["candidate"] as? [String: Any] ?? [:]
            let candidate = RTCIceCandidate(
                sdp: raw["candidate"] as? String ?? "",
                sdpMLineIndex: Int32(raw["sdpMLineIndex"] as? Int ?? 0),
                sdpMid: raw["sdpMid"] as? String)
            try await leader.addIceCandidate(candidate)
        }

        lock.lock()
        var events: [TrayBootstrapEvent] = []
        if !offerSent, let sdp = offerSDP {
            offerSent = true
            cursor += 1
            events.append(
                .offer(
                    sequence: cursor,
                    sentAt: "2099-01-01T00:00:00.000Z",
                    offer: TraySessionDescription(type: .offer, sdp: sdp)))
        }
        let ice = queuedCandidates
        queuedCandidates.removeAll()
        lock.unlock()
        for candidate in ice {
            cursor += 1
            events.append(
                .iceCandidate(
                    sequence: cursor,
                    sentAt: "2099-01-01T00:00:00.000Z",
                    candidate: candidate))
        }

        let payload: [String: Any] = [
            "trayId": trayId,
            "controllerId": controllerId,
            "role": "follower",
            "leader": ["controllerId": "leader", "connected": true],
            "participantCount": 2,
            "bootstrap": try jsonObject(
                bootstrapStatus(controllerId: controllerId, state: .offered)),
            "events": try jsonObject(events),
            "iceServers": [
                [
                    "urls": ["stun:stun.l.google.com:19302"],
                    "username": "",
                    "credential": "",
                ]
            ],
        ]
        return try JSONSerialization.data(withJSONObject: payload)
    }

    private func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        let data = try JSONEncoder().encode(value)
        return try JSONSerialization.jsonObject(with: data)
    }
}

final class RecordingConnectorDelegate: NSObject, TrayFollowerConnectorDelegate {
    let connected = XCTestExpectation(description: "connector connected")
    let received = XCTestExpectation(description: "connector received data")
    private let lock = NSLock()
    private(set) var send: ((Data) -> Bool)?
    private(set) var messages: [Data] = []
    private(set) var info: (String, Int)?

    func connector(_ connector: TrayFollowerConnector, didConnect channelSend: @escaping (Data) -> Bool) {
        lock.lock()
        send = channelSend
        lock.unlock()
        connected.fulfill()
    }

    func connectorDidDisconnect(_ connector: TrayFollowerConnector, reason: String) {}
    func connector(_ connector: TrayFollowerConnector, isReconnecting attempt: Int) {}
    func connector(_ connector: TrayFollowerConnector, didGiveUp lastError: String) {}
    func connector(
        _ connector: TrayFollowerConnector, didReceiveInfo trayId: String, participantCount: Int
    ) {
        info = (trayId, participantCount)
    }
    func connector(_ connector: TrayFollowerConnector, didGenerateCandidate candidate: RTCIceCandidate) {}
    func connector(_ connector: TrayFollowerConnector, didReceiveData data: Data) {
        lock.lock()
        messages.append(data)
        lock.unlock()
        received.fulfill()
    }
}

final class TrayFollowerConnectorLiveTests: XCTestCase {
    func testLiveWebRTCConnectsThroughSignalingAndExchangesData() async throws {
        let hub = LoopbackTrayHub()
        defer { hub.close() }
        try await hub.prepare()

        let delegate = RecordingConnectorDelegate()
        let connector = TrayFollowerConnector(
            joinUrl: hub.joinUrl,
            makeSignaling: { TraySignalingClient(joinUrl: $0, transport: hub.transport) })
        connector.delegate = delegate
        connector.pollIntervalSeconds = 0.02
        connector.maxReconnectAttempts = 0

        let started = expectation(description: "connector start finished")
        started.assertForOverFulfill = false
        var startError: Error?
        let startTask = Task {
            do {
                try await connector.start()
            } catch {
                startError = error
            }
            started.fulfill()
        }
        await fulfillment(of: [started, delegate.connected], timeout: 20)
        if delegate.send == nil || startError != nil {
            connector.stop()
            startTask.cancel()
            XCTFail(
                "live WebRTC did not connect (startError=\(String(describing: startError)))")
            return
        }
        XCTAssertEqual(delegate.info?.0, "tray-live")
        XCTAssertEqual(delegate.info?.1, 2)

        let ping = Data("leader-ping".utf8)
        XCTAssertTrue(hub.leader.send(ping))
        await fulfillment(of: [delegate.received], timeout: 5)
        XCTAssertEqual(delegate.messages, [ping])

        let pong = Data("follower-pong".utf8)
        let leaderGot = expectation(description: "leader got follower pong")
        leaderGot.assertForOverFulfill = false
        hub.leader.onMessage = { data in
            if data == pong { leaderGot.fulfill() }
        }
        XCTAssertTrue(delegate.send?(pong) == true)
        await fulfillment(of: [leaderGot], timeout: 5)

        connector.stop()
        startTask.cancel()
    }

    func testAttachFailureSurfacesTheHubCode() async {
        let joinUrl = URL(string: "https://tray.example/join/expired")!
        let connector = TrayFollowerConnector(
            joinUrl: joinUrl,
            makeSignaling: { url in
                TraySignalingClient(joinUrl: url) { request in
                    let body = Data(
                        #"""
                        {"trayId":"t","controllerId":"c","role":"follower","leader":null,
                         "participantCount":0,
                         "result":{"action":"fail","code":"TRAY_EXPIRED","error":"gone"}}
                        """#.utf8)
                    let response = HTTPURLResponse(
                        url: request.url ?? joinUrl, statusCode: 410, httpVersion: "HTTP/1.1",
                        headerFields: nil)!
                    return (body, response)
                }
            })
        do {
            try await connector.start()
            XCTFail("expected attach failure")
        } catch let error as TrayFollowerConnectorError {
            XCTAssertTrue(error.errorDescription?.contains("TRAY_EXPIRED") == true)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}
