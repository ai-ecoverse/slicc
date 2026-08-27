import Foundation

/// The snapshots the design is drawn against.
///
/// They are shipped in the library, not in a test target, for three reasons a
/// widget cannot avoid: WidgetKit asks the provider for a `placeholder(in:)`
/// before any data exists, the widget gallery renders every family from a
/// `#Preview`, and until the capture side is wired the extensions themselves
/// run on these. Keep them plausible — a fixture that flatters the layout is
/// how a design ships a row that real names overflow.
extension WidgetSnapshot {
    /// Reference date for the fixtures. Fixed, never `Date()`: a preview that
    /// moves under you cannot be compared across screenshots.
    public static let fixtureCaptureDate = Date(timeIntervalSince1970: 1_787_000_000)

    /// Minutes before the capture, as a recency stamp.
    static func ago(_ minutes: Double) -> Date {
        fixtureCaptureDate.addingTimeInterval(-minutes * 60)
    }

    /// The everyday case: one cone with four scoops under it, mid-turn.
    public static var fixtureBusy: WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "trieloff's Chrome",
            runtime: "Chrome",
            connection: .connected,
            capturedAt: fixtureCaptureDate,
            units: [
                WidgetUnit(
                    id: "cone", name: "Sliccy", role: .cone,
                    lifecycle: .working, activity: .thinking, fill: 41,
                    model: "claude-opus-4-6", isActive: true, lastActivityAt: ago(0.5)),
                WidgetUnit(
                    id: "s1", name: "boy-scout", role: .scoop, parentId: "cone",
                    lifecycle: .working, activity: .tool, fill: 18,
                    model: "claude-sonnet-4-5", detail: "pay down boy-scout debt in sidecar-merge.ts",
                    lastActivityAt: ago(1)),
                WidgetUnit(
                    id: "s2", name: "coverage-ratchet", role: .scoop, parentId: "cone",
                    lifecycle: .idle, activity: .awaiting, fill: 63,
                    detail: "raise the node-server floor to 82", lastActivityAt: ago(9)),
                WidgetUnit(
                    id: "s3", name: "release-notes-drafter", role: .scoop, parentId: "cone",
                    lifecycle: .working, activity: .thinking, fill: 88,
                    detail: "draft What to Test notes for 6.99.8", lastActivityAt: ago(2)),
                WidgetUnit(
                    id: "s4", name: "flaky-test-triage", role: .scoop, parentId: "cone",
                    lifecycle: .broken, fill: 12,
                    detail: "playwright-iframe dequeued PR #2015 again", lastActivityAt: ago(4)),
            ],
            lastMessage: WidgetMessage(
                author: .agent, unitId: "cone",
                text:
                    "flaky-test-triage stalled on the playwright-iframe leg again — it is the third dequeue this week. I am pulling the retry counts before I touch the test.",
                at: fixtureCaptureDate.addingTimeInterval(-95))
        )
    }

    /// The quiet case: the turn ended and the composer is the user's.
    public static var fixtureAwaiting: WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "MacBook Pro",
            runtime: "Electron",
            connection: .connected,
            capturedAt: fixtureCaptureDate,
            units: [
                WidgetUnit(
                    id: "cone", name: "Sliccy", role: .cone,
                    lifecycle: .idle, activity: .awaiting, fill: 22,
                    model: "claude-opus-4-6", isActive: true, lastActivityAt: ago(0.7))
            ],
            lastMessage: WidgetMessage(
                author: .agent, unitId: "cone",
                text: "Done — the widget target builds and the appex is staged. Want me to open the PR?",
                at: fixtureCaptureDate.addingTimeInterval(-40))
        )
    }

    /// A cone still booting, before any scoop exists.
    public static var fixtureStarting: WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "sliccy.ai",
            runtime: "Cloud",
            connection: .connected,
            capturedAt: fixtureCaptureDate,
            units: [
                WidgetUnit(
                    id: "cone", name: "Sliccy", role: .cone, lifecycle: .initializing,
                    isActive: true, lastActivityAt: ago(0.1))
            ],
            // Deliberately none: a booting cone has said nothing, and the
            // large family has to survive that without an empty frame.
            lastMessage: nil
        )
    }

    /// Known instance, channel down — the app has been closed for a while.
    public static var fixtureDisconnected: WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "trieloff's Chrome",
            runtime: "Chrome",
            connection: .disconnected,
            capturedAt: fixtureCaptureDate.addingTimeInterval(-52 * 60),
            units: fixtureBusy.units,
            // Shifted back with the capture: a snapshot taken 52 minutes ago
            // cannot be carrying a message from five minutes ago, and the
            // large family prints both times right next to each other.
            lastMessage: WidgetMessage(
                author: .agent, unitId: "cone",
                text: fixtureBusy.lastMessage?.text ?? "",
                at: fixtureCaptureDate.addingTimeInterval(-53 * 60))
        )
    }

    /// Nothing has ever been joined on this device.
    public static var fixtureUnavailable: WidgetSnapshot { .unavailable() }

    /// The stress case the layout has to survive: long names, a deep scoop
    /// list, several roots. Not shipped as a placeholder — used by previews
    /// and the layout tests.
    public static var fixtureCrowded: WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "ai-ecoverse/slicc — staging leader",
            runtime: "Chrome",
            connection: .connected,
            capturedAt: fixtureCaptureDate,
            units: [
                WidgetUnit(
                    id: "cone", name: "Sliccy", role: .cone,
                    lifecycle: .working, activity: .tool, fill: 76, isActive: true, lastActivityAt: ago(0.2)),
                WidgetUnit(
                    id: "s1", name: "packages-webapp-src-fs-sidecar-merge", role: .scoop,
                    parentId: "cone", lifecycle: .working, activity: .thinking, fill: 91,
                    lastActivityAt: ago(1)),
                WidgetUnit(
                    id: "s2", name: "memory-curator", role: .scoop, parentId: "cone",
                    lifecycle: .idle, fill: 34, lastActivityAt: ago(22)),
                WidgetUnit(
                    id: "s3", name: "esp32-toolchain", role: .scoop, parentId: "cone",
                    lifecycle: .working, activity: .tool, fill: 55, lastActivityAt: ago(3)),
                WidgetUnit(
                    id: "s4", name: "ios-transcript", role: .scoop, parentId: "cone",
                    lifecycle: .broken, fill: 70, lastActivityAt: ago(6)),
                WidgetUnit(
                    id: "s5", name: "tray-hub-deploy", role: .scoop, parentId: "cone",
                    lifecycle: .idle, activity: .awaiting, fill: 8, lastActivityAt: ago(11)),
                WidgetUnit(
                    id: "cone2", name: "Nightly", role: .cone, lifecycle: .working,
                    activity: .thinking, fill: 29, lastActivityAt: ago(1.5)),
                WidgetUnit(
                    id: "s6", name: "debt-triage", role: .scoop, parentId: "cone2",
                    lifecycle: .working, activity: .tool, fill: 44, lastActivityAt: ago(0.7)),
            ],
            // A user turn, so the preview's other attribution gets drawn too.
            lastMessage: WidgetMessage(
                author: .user,
                text: "hold off on the ios-transcript one until I have looked at the device trace",
                at: fixtureCaptureDate.addingTimeInterval(-600))
        )
    }

    /// Every fixture, in gallery order — the set a preview grid and the
    /// layout tests both walk so a new state cannot be added without being
    /// drawn.
    public static var allFixtures: [(name: String, snapshot: WidgetSnapshot)] {
        [
            ("busy", .fixtureBusy),
            ("awaiting", .fixtureAwaiting),
            ("starting", .fixtureStarting),
            ("crowded", .fixtureCrowded),
            ("disconnected", .fixtureDisconnected),
            ("unavailable", .fixtureUnavailable),
        ]
    }
}
