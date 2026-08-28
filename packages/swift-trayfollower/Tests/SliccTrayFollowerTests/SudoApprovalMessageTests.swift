import Foundation
import XCTest

@testable import SliccTrayFollower

/// Tray sync v7 (#2062): the delegated-sudo triple, push registration, and
/// the two new capability flags — encode + decode in both directions.
final class SudoApprovalMessageTests: XCTestCase {
    // MARK: - Leader → follower

    func testSudoApproveRequestRoundTrip() throws {
        let message = LeaderToFollowerMessage.sudoApproveRequest(
            requestId: "sudo-1",
            kind: "command",
            detail: "git push origin main",
            requester: "biscotto \u{201C}Anna\u{201D}",
            suggestedPattern: "git push *",
            scoopName: "Researcher",
            expiresAt: 1_750_000_300_000)
        guard
            case .sudoApproveRequest(
                let id, let kind, let detail, let requester, let pattern, let scoop, let exp) =
                try WireCodec.roundTrip(message)
        else { return XCTFail("expected sudoApproveRequest") }
        XCTAssertEqual([id, kind, detail, pattern, scoop], ["sudo-1", "command", "git push origin main", "git push *", "Researcher"])
        // Without this the reviewer sees only `detail`, which for a guest
        // message is the requester's own account of who they are.
        XCTAssertEqual(requester, "biscotto \u{201C}Anna\u{201D}")
        XCTAssertEqual(exp, 1_750_000_300_000)
        let json = try WireCodec.jsonString(message)
        XCTAssertTrue(json.contains(#""type":"sudo.approve.request""#))
        XCTAssertTrue(json.contains(#""expiresAt":1750000300000"#))
    }

    func testSudoApproveRequestOptionalFieldsDecodeAbsent() throws {
        let wire = #"{"type":"sudo.approve.request","requestId":"p","kind":"export","detail":"active","expiresAt":1}"#
        guard
            case .sudoApproveRequest(_, let kind, _, let requester, let pattern, let scoop, _) =
                try WireCodec.decode(LeaderToFollowerMessage.self, from: wire)
        else { return XCTFail("expected sudoApproveRequest") }
        XCTAssertEqual(kind, "export")
        XCTAssertNil(requester)
        XCTAssertNil(pattern)
        XCTAssertNil(scoop)
        // Re-encoding never invents the optional keys.
        let json = try WireCodec.jsonString(
            LeaderToFollowerMessage.sudoApproveRequest(
                requestId: "p", kind: "export", detail: "active", requester: nil,
                suggestedPattern: nil, scoopName: nil, expiresAt: 1))
        XCTAssertFalse(json.contains("requester"))
        XCTAssertFalse(json.contains("suggestedPattern"))
        XCTAssertFalse(json.contains("scoopName"))
    }

    func testSudoApproveCancelRoundTrip() throws {
        guard case .sudoApproveCancel(let id) = try WireCodec.roundTrip(LeaderToFollowerMessage.sudoApproveCancel(requestId: "sudo-9"))
        else { return XCTFail("expected sudoApproveCancel") }
        XCTAssertEqual(id, "sudo-9")
        XCTAssertTrue(try WireCodec.jsonString(LeaderToFollowerMessage.sudoApproveCancel(requestId: "x")).contains(#""type":"sudo.approve.cancel""#))
    }

    // MARK: - Follower → leader

    func testSudoApproveResponseRoundTrip() throws {
        let message = FollowerToLeaderMessage.sudoApproveResponse(
            requestId: "sudo-1", decision: "always", pattern: "git push *", attestation: "biometric")
        guard case .sudoApproveResponse(let id, let decision, let pattern, let attestation) = try WireCodec.roundTrip(message)
        else { return XCTFail("expected sudoApproveResponse") }
        XCTAssertEqual([id, decision, pattern, attestation], ["sudo-1", "always", "git push *", "biometric"])
        XCTAssertTrue(try WireCodec.jsonString(message).contains(#""type":"sudo.approve.response""#))

        let deny = try WireCodec.jsonString(
            FollowerToLeaderMessage.sudoApproveResponse(requestId: "d", decision: "deny", pattern: nil, attestation: nil))
        XCTAssertFalse(deny.contains("pattern"))
        XCTAssertFalse(deny.contains("attestation"))
    }

    func testPushRegisterRoundTrip() throws {
        let token = String(repeating: "a", count: 64)
        let message = FollowerToLeaderMessage.pushRegister(platform: "ios", token: token, environment: "production")
        guard case .pushRegister(let platform, let decodedToken, let environment) = try WireCodec.roundTrip(message)
        else { return XCTFail("expected pushRegister") }
        XCTAssertEqual([platform, decodedToken, environment], ["ios", token, "production"])
        XCTAssertTrue(try WireCodec.jsonString(message).contains(#""type":"push.register""#))
    }

    // MARK: - Capabilities

    func testCapabilityFlagsRoundTripAndOmitWhenNil() throws {
        let full = TraySyncCapabilities(exec: true, browser: true, oauthPopup: nil, sudoApproval: true, biometric: true)
        XCTAssertEqual(try WireCodec.roundTrip(full), full)
        let json = try WireCodec.jsonString(full)
        XCTAssertTrue(json.contains(#""sudoApproval":true"#))
        XCTAssertTrue(json.contains(#""biometric":true"#))
        XCTAssertFalse(json.contains("oauthPopup"))

        let legacy = try WireCodec.decode(TraySyncCapabilities.self, from: #"{"exec":false}"#)
        XCTAssertNil(legacy.sudoApproval)
        XCTAssertNil(legacy.biometric)
    }

    func testFollowerCapabilitiesFactory() {
        let withAuth = makeTrayFollowerCapabilities(deviceOwnerAuth: true)
        XCTAssertEqual(withAuth.sudoApproval, true)
        XCTAssertEqual(withAuth.biometric, true)
        XCTAssertTrue(withAuth.exec)
        XCTAssertEqual(withAuth.browser, true)
        let withoutAuth = makeTrayFollowerCapabilities(deviceOwnerAuth: false)
        XCTAssertEqual(withoutAuth.sudoApproval, true)
        XCTAssertNil(withoutAuth.biometric)
        XCTAssertEqual(withoutAuth, trayFollowerCapabilities)
    }
}
