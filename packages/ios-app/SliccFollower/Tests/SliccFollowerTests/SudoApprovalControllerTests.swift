import Foundation
import XCTest

@testable import SliccTrayKit

/// Delegated sudo approval (#2062): the controller owns the pending cards,
/// gates Allow / Always behind device-owner authentication, and replies
/// fail-closed. No leader, no biometric sensor — everything is injected.
@MainActor
final class SudoApprovalControllerTests: XCTestCase {
    private final class Wire {
        var sent: [FollowerToLeaderMessage] = []
        var succeeds = true
        func send(_ message: FollowerToLeaderMessage) -> Bool {
            guard succeeds else { return false }
            sent.append(message)
            return true
        }
        var responses: [(requestId: String, decision: String, pattern: String?, attestation: String?)] {
            sent.compactMap {
                if case .sudoApproveResponse(let id, let d, let p, let a) = $0 {
                    return (id, d, p, a)
                }
                return nil
            }
        }
    }

    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_750_000_000)
    }

    private final class Gate {
        var outcome: SudoAuthOutcome = .authenticated(.biometric)
        var reasons: [String] = []
    }

    private struct Harness {
        let controller: SudoApprovalController
        let wire: Wire
        let clock: Clock
        let gate: Gate
        let recorder: Recorder
    }

    private func makeHarness() -> Harness {
        let wire = Wire()
        let clock = Clock()
        let gate = Gate()
        let recorder = Recorder()
        let controller = SudoApprovalController(
            send: { wire.send($0) },
            authenticate: { reason in
                await MainActor.run { gate.reasons.append(reason) }
                return await MainActor.run { gate.outcome }
            },
            now: { clock.now },
            onPendingChanged: { recorder.pending.append($0) },
            onArrived: { recorder.arrived.append($0.requestId) },
            onWithdrawn: { recorder.withdrawn.append($0) })
        return Harness(controller: controller, wire: wire, clock: clock, gate: gate, recorder: recorder)
    }

    private final class Recorder {
        var pending: [[SudoApprovalRequest]] = []
        var arrived: [String] = []
        var withdrawn: [String] = []
    }

    private func prompt(_ controller: SudoApprovalController, clock: Clock, id: String = "sudo-1") {
        controller.handle(
            requestId: id,
            kind: "command",
            detail: "git push origin main",
            suggestedPattern: "git push *",
            scoopName: "Researcher",
            expiresAt: clock.now.addingTimeInterval(300))
    }

    func testPromptQueuesAndNotifies() {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        prompt(controller, clock: clock)
        XCTAssertEqual(controller.pending.map(\.requestId), ["sudo-1"])
        XCTAssertEqual(recorder.arrived, ["sudo-1"])
        // A duplicate changes nothing.
        prompt(controller, clock: clock)
        XCTAssertEqual(controller.pending.count, 1)
        XCTAssertEqual(recorder.arrived.count, 1)
    }

    func testExpiredPromptIsDropped() {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        controller.handle(
            requestId: "late", kind: "command", detail: "x", suggestedPattern: nil,
            scoopName: nil, expiresAt: clock.now.addingTimeInterval(-1))
        XCTAssertTrue(controller.pending.isEmpty)
        XCTAssertTrue(recorder.arrived.isEmpty)
    }

    func testDenyNeedsNoAuthentication() async {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        prompt(controller, clock: clock)
        await controller.resolve(requestId: "sudo-1", decision: .deny)
        XCTAssertTrue(gate.reasons.isEmpty)
        XCTAssertEqual(wire.responses.count, 1)
        XCTAssertEqual(wire.responses[0].decision, "deny")
        XCTAssertNil(wire.responses[0].attestation)
        XCTAssertTrue(controller.pending.isEmpty)
        XCTAssertEqual(recorder.withdrawn, ["sudo-1"])
    }

    func testAllowRunsTheGateAndReportsAttestation() async {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        gate.outcome = .authenticated(.passcode)
        prompt(controller, clock: clock)
        await controller.resolve(requestId: "sudo-1", decision: .allowOnce)
        XCTAssertEqual(gate.reasons, ["Allow command: git push origin main"])
        XCTAssertEqual(wire.responses[0].decision, "allow")
        XCTAssertEqual(wire.responses[0].attestation, "passcode")
        XCTAssertNil(wire.responses[0].pattern)
    }

    func testRefusedGateDenies() async {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        gate.outcome = .refused
        prompt(controller, clock: clock)
        await controller.resolve(requestId: "sudo-1", decision: .allowOnce)
        XCTAssertEqual(wire.responses.map(\.decision), ["deny"])
        XCTAssertTrue(controller.pending.isEmpty)
    }

    func testAlwaysCarriesTheEditedPatternAndFallsBackToTheSuggestion() async {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        prompt(controller, clock: clock, id: "a")
        prompt(controller, clock: clock, id: "b")
        await controller.resolve(requestId: "a", decision: .always(pattern: " git push origin * "))
        await controller.resolve(requestId: "b", decision: .always(pattern: "   "))
        XCTAssertEqual(wire.responses[0].decision, "always")
        XCTAssertEqual(wire.responses[0].pattern, "git push origin *")
        XCTAssertEqual(wire.responses[0].attestation, "biometric")
        XCTAssertEqual(wire.responses[1].pattern, "git push *")
    }

    func testCancelWithdrawsWithoutReplying() {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        prompt(controller, clock: clock)
        controller.cancel(requestId: "sudo-1")
        XCTAssertTrue(controller.pending.isEmpty)
        XCTAssertTrue(wire.sent.isEmpty)
        XCTAssertEqual(recorder.withdrawn, ["sudo-1"])
        // Unknown ids are ignored.
        controller.cancel(requestId: "nope")
        XCTAssertEqual(recorder.withdrawn, ["sudo-1"])
    }

    func testTransportLossClearsEverythingSilently() {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        prompt(controller, clock: clock, id: "a")
        prompt(controller, clock: clock, id: "b")
        controller.transportLost()
        XCTAssertTrue(controller.pending.isEmpty)
        XCTAssertTrue(wire.sent.isEmpty)
        XCTAssertEqual(Set(recorder.withdrawn), ["a", "b"])
    }

    func testDenyFromNotificationRepliesWithoutGate() {
        let h = makeHarness()
        let controller = h.controller
        let wire = h.wire
        let clock = h.clock
        let gate = h.gate
        let recorder = h.recorder
        prompt(controller, clock: clock)
        controller.denyFromNotification(requestId: "sudo-1")
        XCTAssertTrue(gate.reasons.isEmpty)
        XCTAssertEqual(wire.responses.map(\.decision), ["deny"])
        // Answering twice is impossible.
        controller.denyFromNotification(requestId: "sudo-1")
        XCTAssertEqual(wire.responses.count, 1)
    }

    func testExportPromptsReadAsSessions() {
        let request = SudoApprovalRequest(
            requestId: "e", kind: "export", detail: "frozen:sess-42", suggestedPattern: nil,
            scoopName: nil, expiresAt: Date(), receivedAt: Date())
        XCTAssertEqual(request.heading, "Export transcript?")
        XCTAssertEqual(request.displayDetail, "Archived session (sess-42)")
        XCTAssertEqual(request.defaultPattern, "frozen:sess-42")
        XCTAssertEqual(
            SudoApprovalController.authReason(for: request),
            "Allow export: Archived session (sess-42)")
    }

    func testWireRoundTrip() throws {
        let response = FollowerToLeaderMessage.sudoApproveResponse(
            requestId: "r", decision: "always", pattern: "git push *", attestation: "biometric")
        let data = try JSONEncoder().encode(response)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["type"] as? String, "sudo.approve.response")
        XCTAssertEqual(json["pattern"] as? String, "git push *")
        let register = FollowerToLeaderMessage.pushRegister(
            platform: "ios", token: String(repeating: "a", count: 64), environment: "sandbox")
        let registerJson = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try JSONEncoder().encode(register)) as? [String: Any])
        XCTAssertEqual(registerJson["type"] as? String, "push.register")
        XCTAssertEqual(registerJson["environment"] as? String, "sandbox")

        let prompt = """
            {"type":"sudo.approve.request","requestId":"p","kind":"write","detail":"/etc/sudoers",
             "expiresAt":1750000300000}
            """
        let decoded = try JSONDecoder().decode(
            LeaderToFollowerMessage.self, from: Data(prompt.utf8))
        guard case .sudoApproveRequest(let id, let kind, let detail, let pattern, let scoop, let exp) = decoded
        else { return XCTFail("expected sudoApproveRequest, got \(decoded)") }
        XCTAssertEqual([id, kind, detail], ["p", "write", "/etc/sudoers"])
        XCTAssertNil(pattern)
        XCTAssertNil(scoop)
        XCTAssertEqual(exp, 1_750_000_300_000)
    }
}
