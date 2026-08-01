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
        XCTAssertEqual(TraySessionRow.age(of: now, now: now), "just now")
        XCTAssertEqual(TraySessionRow.age(of: now.addingTimeInterval(-120), now: now), "2m ago")
        XCTAssertEqual(TraySessionRow.age(of: now.addingTimeInterval(-7200), now: now), "2h ago")
        XCTAssertEqual(TraySessionRow.age(of: now.addingTimeInterval(-172_800), now: now), "2d ago")
    }

    func testTraySessionRowSubtitle() {
        let now = Date()
        XCTAssertEqual(
            TraySessionRow.subtitle(
                isLocal: true,
                deviceName: "Ignored",
                lastSeenAt: now,
                now: now
            ),
            "This device · just now"
        )
        XCTAssertEqual(
            TraySessionRow.subtitle(
                isLocal: false,
                deviceName: "MacBook",
                lastSeenAt: now.addingTimeInterval(-120),
                now: now
            ),
            "MacBook · 2m ago"
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
}
