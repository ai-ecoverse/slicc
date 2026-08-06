import AppKit
import SliccTraySession
import XCTest

@testable import Sliccstart

/// Launcher-side iCloud-session surfaces: the `TraySessionRow` presentation
/// helpers and the remote-follow override. The model/store tests live with the
/// shared package in `packages/swift-traysession`.
@MainActor
final class TraySessionLauncherTests: XCTestCase {
    // MARK: - Age formatting

    func testAgeFormatting() {
        let now = Date(timeIntervalSince1970: 100_000)
        XCTAssertEqual(TraySessionPresentation.age(of: now, now: now), "just now")
        XCTAssertEqual(TraySessionPresentation.age(of: now.addingTimeInterval(-120), now: now), "2m ago")
        XCTAssertEqual(TraySessionPresentation.age(of: now.addingTimeInterval(-7200), now: now), "2h ago")
        XCTAssertEqual(TraySessionPresentation.age(of: now.addingTimeInterval(-172_800), now: now), "2d ago")
    }

    func testTraySessionRowSubtitle() {
        let now = Date()
        XCTAssertEqual(
            TraySessionPresentation.subtitle(
                isLocal: true,
                deviceName: "Ignored",
                lastSeenAt: now,
                verdict: nil,
                now: now
            ),
            "This device · just now"
        )
        XCTAssertEqual(
            TraySessionPresentation.subtitle(
                isLocal: false,
                deviceName: "MacBook",
                lastSeenAt: now.addingTimeInterval(-120),
                verdict: .reachable,
                now: now
            ),
            "MacBook · 2m ago"
        )
    }

    func testUnreachableSessionsSortLastWithoutReorderingCohorts() {
        let firstUnprobed = session(url: "https://one.invalid/join/a", label: "One")
        let firstUnreachable = session(url: "https://two.invalid/join/b", label: "Two")
        let reachable = session(url: "https://three.invalid/join/c", label: "Three")
        let secondUnreachable = session(url: "https://four.invalid/join/d", label: "Four")
        let sessions = [firstUnprobed, firstUnreachable, reachable, secondUnreachable]
        let verdicts: [String: SessionReachability.Verdict] = [
            firstUnreachable.id: .unreachable,
            reachable.id: .reachable,
            secondUnreachable.id: .unreachable,
        ]

        let sorted = TraySessionPresentation.sortedRemoteSessions(sessions, verdicts: verdicts)

        XCTAssertEqual(sorted.map(\.id), [firstUnprobed.id, reachable.id, firstUnreachable.id, secondUnreachable.id])
    }

    func testUnreachableSubtitleIncludesNotRespondingHint() {
        let now = Date()

        XCTAssertEqual(
            TraySessionPresentation.subtitle(
                isLocal: false,
                deviceName: "MacBook",
                lastSeenAt: now.addingTimeInterval(-120),
                verdict: .unreachable,
                now: now
            ),
            "MacBook · 2m ago · not responding"
        )
    }

    func testUnreachableSessionDisablesRemoteActions() {
        XCTAssertFalse(
            TraySessionPresentation.remoteActionEnabled(available: true, verdict: .unreachable)
        )
        XCTAssertTrue(
            TraySessionPresentation.remoteActionEnabled(available: true, verdict: .reachable)
        )
        XCTAssertTrue(
            TraySessionPresentation.remoteActionEnabled(available: true, verdict: nil)
        )
    }

    // MARK: - Remote follow override

    func testTerminalFollowerUsesOverrideWithoutLocalLeader() async throws {
        var launchedCommand: String?
        let service = TerminalFollowerLaunchService(
            findCliBinary: { "/usr/local/bin/slicc" },
            downloadCli: { _ in URL(fileURLWithPath: "/unused") },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, command in launchedCommand = command }
        )
        let process = SliccProcess(terminalFollowerLaunchService: service)
        // No leader seeded and leaderJoinUrl is nil — the override must still
        // drive a follower attaching to the remote leader.
        XCTAssertFalse(process.isLeaderReady())

        try await process.launchTerminalFollower(
            terminalTarget(),
            joinURLOverride: "https://remote.test/join/token.secret"
        )

        XCTAssertEqual(
            launchedCommand,
            "/usr/local/bin/slicc https://remote.test/join/token.secret follow /bin/zsh -c"
        )
    }

    // MARK: - Helpers

    private func terminalTarget() -> AppTarget {
        AppTarget(
            id: UUID().uuidString,
            name: "Terminal",
            path: "/Applications/Terminal.app",
            executablePath: "/Applications/Terminal.app/Contents/MacOS/Terminal",
            type: .terminal,
            icon: NSImage(),
            debugSupport: .unknown,
            isDebugBuild: false,
            originalAppPath: nil
        )
    }

    private func session(url: String, label: String) -> SyncedTraySession {
        SyncedTraySession(
            joinUrl: url,
            label: label,
            deviceId: "remote-device",
            deviceName: "MacBook",
            createdAt: Date(),
            lastSeenAt: Date()
        )
    }
}
