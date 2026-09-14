import Foundation









extension WidgetSnapshot {
    
    
    public static let fixtureCaptureDate = Date(timeIntervalSince1970: 1_787_000_000)

    
    static func ago(_ minutes: Double) -> Date {
        fixtureCaptureDate.addingTimeInterval(-minutes * 60)
    }

    
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
            
            
            lastMessage: nil
        )
    }

    
    public static var fixtureDisconnected: WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "trieloff's Chrome",
            runtime: "Chrome",
            connection: .disconnected,
            capturedAt: fixtureCaptureDate.addingTimeInterval(-52 * 60),
            units: fixtureBusy.units,
            
            
            
            lastMessage: WidgetMessage(
                author: .agent, unitId: "cone",
                text: fixtureBusy.lastMessage?.text ?? "",
                at: fixtureCaptureDate.addingTimeInterval(-53 * 60))
        )
    }

    
    public static var fixtureUnavailable: WidgetSnapshot { .unavailable() }

    
    
    
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
            
            lastMessage: WidgetMessage(
                author: .user,
                text: "hold off on the ios-transcript one until I have looked at the device trace",
                at: fixtureCaptureDate.addingTimeInterval(-600))
        )
    }

    
    
    
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
