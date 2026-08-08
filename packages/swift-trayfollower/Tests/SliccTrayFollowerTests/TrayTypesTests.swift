import Foundation
import XCTest

@testable import SliccTrayFollower

/// The tray signaling payload types from `TrayTypes.swift`, most notably the
/// custom `TrayBootstrapEvent` union with its `bootstrap.*` discriminators.
final class TrayTypesTests: XCTestCase {

    private func sampleOffer() -> TraySessionDescription {
        TraySessionDescription(type: .offer, sdp: "v=0")
    }

    private func sampleCandidate() -> TrayIceCandidate {
        TrayIceCandidate(candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "ufrag")
    }

    private func sampleFailure() -> TrayBootstrapFailure {
        TrayBootstrapFailure(code: "TIMEOUT", message: "took too long", retryable: true, retryAfterMs: 500, failedAt: "2026-08-08T00:00:00Z")
    }

    // MARK: - TraySessionDescription / TrayIceCandidate

    func testSessionDescriptionRoundTrip() throws {
        let decoded = try WireCodec.roundTrip(TraySessionDescription(type: .answer, sdp: "v=0\r\n"))
        XCTAssertEqual(decoded.type, .answer)
        XCTAssertEqual(decoded.sdp, "v=0\r\n")
    }

    func testSessionDescriptionTypeRawValues() {
        XCTAssertEqual(TraySessionDescription.SDPType.offer.rawValue, "offer")
        XCTAssertEqual(TraySessionDescription.SDPType.answer.rawValue, "answer")
    }

    func testIceCandidateRoundTrip() throws {
        let decoded = try WireCodec.roundTrip(sampleCandidate())
        XCTAssertEqual(decoded.candidate, "candidate:1")
        XCTAssertEqual(decoded.sdpMid, "0")
        XCTAssertEqual(decoded.sdpMLineIndex, 0)
        XCTAssertEqual(decoded.usernameFragment, "ufrag")
    }

    func testIceCandidateWithNilOptionals() throws {
        let decoded = try WireCodec.roundTrip(
            TrayIceCandidate(candidate: "candidate:2", sdpMid: nil, sdpMLineIndex: nil, usernameFragment: nil))
        XCTAssertEqual(decoded.candidate, "candidate:2")
        XCTAssertNil(decoded.sdpMid)
        XCTAssertNil(decoded.sdpMLineIndex)
        XCTAssertNil(decoded.usernameFragment)
    }

    // MARK: - Bootstrap status / failure / state

    func testBootstrapStateRoundTrips() throws {
        for state in [TrayBootstrapState.pending, .offered, .connected, .failed] {
            XCTAssertEqual(try WireCodec.roundTrip(state), state)
        }
    }

    func testBootstrapFailureRoundTrip() throws {
        let decoded = try WireCodec.roundTrip(sampleFailure())
        XCTAssertEqual(decoded.code, "TIMEOUT")
        XCTAssertEqual(decoded.message, "took too long")
        XCTAssertTrue(decoded.retryable)
        XCTAssertEqual(decoded.retryAfterMs, 500)
        XCTAssertEqual(decoded.failedAt, "2026-08-08T00:00:00Z")
    }

    func testBootstrapStatusRoundTrip() throws {
        let status = TrayBootstrapStatus(
            controllerId: "c1", bootstrapId: "b1", attempt: 2, state: .offered,
            expiresAt: "2026-08-08T01:00:00Z", cursor: 3, maxRetries: 5, retriesRemaining: 3,
            retryAfterMs: 250, failure: sampleFailure())
        let decoded = try WireCodec.roundTrip(status)
        XCTAssertEqual(decoded.controllerId, "c1")
        XCTAssertEqual(decoded.bootstrapId, "b1")
        XCTAssertEqual(decoded.attempt, 2)
        XCTAssertEqual(decoded.state, .offered)
        XCTAssertEqual(decoded.cursor, 3)
        XCTAssertEqual(decoded.maxRetries, 5)
        XCTAssertEqual(decoded.retriesRemaining, 3)
        XCTAssertEqual(decoded.retryAfterMs, 250)
        XCTAssertEqual(decoded.failure?.code, "TIMEOUT")
    }

    func testBootstrapStatusWithoutFailure() throws {
        let status = TrayBootstrapStatus(
            controllerId: "c1", bootstrapId: "b1", attempt: 0, state: .connected,
            expiresAt: "2026-08-08T01:00:00Z", cursor: 0, maxRetries: 5, retriesRemaining: 5,
            retryAfterMs: nil, failure: nil)
        let decoded = try WireCodec.roundTrip(status)
        XCTAssertNil(decoded.retryAfterMs)
        XCTAssertNil(decoded.failure)
    }

    // MARK: - TurnIceServer / TrayLeaderSummary

    func testTurnIceServerRoundTrip() throws {
        let decoded = try WireCodec.roundTrip(
            TurnIceServer(urls: ["turn:host:3478", "stun:host:3478"], username: "u", credential: "c"))
        XCTAssertEqual(decoded.urls, ["turn:host:3478", "stun:host:3478"])
        XCTAssertEqual(decoded.username, "u")
        XCTAssertEqual(decoded.credential, "c")
    }

    func testLeaderSummaryRoundTrip() throws {
        let decoded = try WireCodec.roundTrip(
            TrayLeaderSummary(controllerId: "c1", connected: true, reconnectDeadline: "2026-08-08T02:00:00Z"))
        XCTAssertEqual(decoded.controllerId, "c1")
        XCTAssertTrue(decoded.connected)
        XCTAssertEqual(decoded.reconnectDeadline, "2026-08-08T02:00:00Z")
    }

    func testLeaderSummaryWithoutDeadline() throws {
        let decoded = try WireCodec.roundTrip(TrayLeaderSummary(controllerId: "c1", connected: false, reconnectDeadline: nil))
        XCTAssertNil(decoded.reconnectDeadline)
    }

    // MARK: - TrayBootstrapEvent union

    func testBootstrapOfferEventRoundTrip() throws {
        guard
            case .offer(let sequence, let sentAt, let offer) =
                try WireCodec.roundTrip(TrayBootstrapEvent.offer(sequence: 1, sentAt: "2026-08-08T00:00:00Z", offer: sampleOffer()))
        else {
            XCTFail("expected offer")
            return
        }
        XCTAssertEqual(sequence, 1)
        XCTAssertEqual(sentAt, "2026-08-08T00:00:00Z")
        XCTAssertEqual(offer.type, .offer)
        XCTAssertEqual(offer.sdp, "v=0")
    }

    func testBootstrapIceCandidateEventRoundTrip() throws {
        guard
            case .iceCandidate(let sequence, _, let candidate) =
                try WireCodec.roundTrip(TrayBootstrapEvent.iceCandidate(sequence: 2, sentAt: "t", candidate: sampleCandidate()))
        else {
            XCTFail("expected iceCandidate")
            return
        }
        XCTAssertEqual(sequence, 2)
        XCTAssertEqual(candidate.candidate, "candidate:1")
    }

    func testBootstrapFailedEventRoundTrip() throws {
        guard
            case .failed(let sequence, _, let failure) =
                try WireCodec.roundTrip(TrayBootstrapEvent.failed(sequence: 3, sentAt: "t", failure: sampleFailure()))
        else {
            XCTFail("expected failed")
            return
        }
        XCTAssertEqual(sequence, 3)
        XCTAssertEqual(failure.code, "TIMEOUT")
    }

    func testBootstrapEventDiscriminators() throws {
        XCTAssertEqual(
            try WireCodec.discriminator(TrayBootstrapEvent.offer(sequence: 1, sentAt: "t", offer: sampleOffer())),
            "bootstrap.offer")
        XCTAssertEqual(
            try WireCodec.discriminator(TrayBootstrapEvent.iceCandidate(sequence: 1, sentAt: "t", candidate: sampleCandidate())),
            "bootstrap.ice_candidate")
        XCTAssertEqual(
            try WireCodec.discriminator(TrayBootstrapEvent.failed(sequence: 1, sentAt: "t", failure: sampleFailure())),
            "bootstrap.failed")
    }

    func testUnknownBootstrapEventTypeThrows() {
        XCTAssertThrowsError(
            try WireCodec.decode(TrayBootstrapEvent.self, from: #"{"type":"bootstrap.mystery","sequence":1,"sentAt":"t"}"#)
        ) { error in
            guard case DecodingError.dataCorrupted = error else {
                XCTFail("expected dataCorrupted, got \(error)")
                return
            }
        }
    }
}
