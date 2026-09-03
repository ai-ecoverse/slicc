import Foundation
import SliccTrayFollower
import SliccWidgetKit
import XCTest

@testable import Sliccstart

/// A connector that never touches a network. The observer's whole job is
/// wiring — what it dials, when, and what it writes — so that is what these
/// exercise.
@MainActor
private final class StubConnector: WidgetTrayConnecting {
    weak var delegate: TrayFollowerConnectorDelegate?
    private(set) var started = 0
    private(set) var stopped = 0
    var startError: Error?

    func start() async throws {
        started += 1
        if let startError { throw startError }
    }

    func stop() { stopped += 1 }
}

private struct StubError: Error {}

/// A flag the installation query reads, flippable from a test.
private actor Installed {
    var value: Bool
    init(value: Bool) { self.value = value }
    func set(_ next: Bool) { value = next }
}

/// Holds an installation query open until the test lets it answer, and tells
/// the test when the query has actually STARTED.
///
/// Both halves matter. Without `waitUntilEntered` the test changes the leader
/// before the sync task has begun running, so the sync returns at its very
/// first guard and the race it claims to stage never happens — which is
/// exactly how the first version of this passed against the bug.
private actor Gate {
    private var answer: CheckedContinuation<Void, Never>?
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var opened = false
    private var entered = false

    func wait() async {
        entered = true
        for waiter in entryWaiters { waiter.resume() }
        entryWaiters.removeAll()
        if opened { return }
        await withCheckedContinuation { answer = $0 }
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { entryWaiters.append($0) }
    }

    func open() {
        opened = true
        answer?.resume()
        answer = nil
    }
}

@MainActor
final class WidgetTrayObserverTests: XCTestCase {
    private var container: URL!
    private var store: WidgetSnapshotStore!
    private var connectors: [StubConnector] = []

    override func setUp() async throws {
        container = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("widget-observer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        store = WidgetSnapshotStore(appGroup: "test") { [container] _ in container }
        connectors = []
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: container)
    }

    private func makeObserver(widgetInstalled: Bool = true) -> WidgetTrayObserver {
        makeObserver(installation: WidgetInstallationQuery { widgetInstalled })
    }

    private func makeObserver(installation: WidgetInstallationQuery) -> WidgetTrayObserver {
        WidgetTrayObserver(
            publisher: WidgetSnapshotPublisher(store: store, minimumInterval: 0),
            installation: installation,
            makeConnector: { [unowned self] _ in
                let connector = StubConnector()
                connectors.append(connector)
                return connector
            })
    }

    private func scoopsList(active: String = "cone") -> Data {
        let message = LeaderToFollowerMessage.scoopsList(
            scoops: [
                ScoopSummary(
                    jid: "cone", name: "cone", folder: "/", isCone: true,
                    assistantLabel: "Sliccy", state: "working", activity: "thinking", fill: 30,
                    parentId: nil),
                ScoopSummary(
                    jid: "s1", name: "s1", folder: "/s", isCone: false,
                    assistantLabel: "boy-scout", state: "broken", fill: 5, parentId: "cone"),
            ],
            activeScoopJid: active)
        return try! JSONEncoder().encode(message)
    }

    /// The whole point of the gate: a launcher must not hold a WebRTC
    /// participant slot open in someone else's session to feed a tile nobody
    /// added.
    func testNoWidgetMeansNoConnection() async {
        let observer = makeObserver(widgetInstalled: false)
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()

        XCTAssertTrue(connectors.isEmpty)
        XCTAssertNil(store.read())
    }

    func testAnInstalledWidgetDialsTheLeaderOnce() async {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()

        XCTAssertEqual(connectors.count, 1)
        XCTAssertEqual(connectors.first?.started, 1)

        // The same leader again is not a new connection.
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()
        XCTAssertEqual(connectors.count, 1)
    }

    /// A leader that goes away takes the snapshot with it — a desktop widget
    /// must not keep naming a session that has ended.
    func testLosingTheLeaderClearsTheSnapshot() async throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()
        observer.route(scoopsList())
        XCTAssertNotNil(store.read())

        observer.leaderChanged(joinUrl: nil, label: nil)
        await observer._testing_settle()

        XCTAssertNil(store.read())
        XCTAssertEqual(connectors.first?.stopped, 1)
    }

    func testAFailedAttachDoesNotStrandTheConnector() async {
        let observer = WidgetTrayObserver(
            publisher: WidgetSnapshotPublisher(store: store, minimumInterval: 0),
            installation: WidgetInstallationQuery { true },
            makeConnector: { [unowned self] _ in
                let connector = StubConnector()
                connector.startError = StubError()
                connectors.append(connector)
                return connector
            })
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()

        // A second look must be able to retry rather than believing it is
        // already connected.
        observer.refresh()
        await observer._testing_settle()
        XCTAssertEqual(connectors.count, 2)
    }

    /// The gate has to work in BOTH directions. An early `guard connector ==
    /// nil` meant a later refresh never asked WidgetKit again, so removing the
    /// widget left the tray participant and the WebRTC link alive for a tile
    /// that no longer existed.
    func testRemovingTheWidgetDropsTheConnection() async {
        let installed = Installed(value: true)
        let observer = makeObserver(
            installation: WidgetInstallationQuery { await installed.value })
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()
        XCTAssertEqual(connectors.count, 1)

        await installed.set(false)
        observer.refresh()
        await observer._testing_settle()

        XCTAssertEqual(connectors.first?.stopped, 1, "the connection outlived the widget")
    }

    func testAStillInstalledWidgetIsNotRedialedOnEveryRefresh() async {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()
        observer.refresh()
        await observer._testing_settle()

        XCTAssertEqual(connectors.count, 1)
        XCTAssertEqual(connectors.first?.stopped, 0)
    }

    /// Cancelling `startTask` does not cancel a checked continuation already
    /// in flight, so the installation query can come back after the user has
    /// left — and must not attach to the leader it captured.
    func testAnInFlightQueryCannotAttachToAnAbandonedLeader() async {
        let gate = Gate()
        let observer = makeObserver(
            installation: WidgetInstallationQuery {
                await gate.wait()
                return true
            })
        observer.leaderChanged(joinUrl: "https://tray.test/join/old", label: "Old")
        // Only once the query has genuinely started is there a race to stage.
        await gate.waitUntilEntered()
        // The user detaches before it answers.
        observer.leaderChanged(joinUrl: nil, label: nil)
        await gate.open()
        await observer._testing_settle()

        XCTAssertTrue(connectors.isEmpty, "attached to a leader that had already been left")
        XCTAssertNil(store.read())
    }

    // MARK: Wire → snapshot

    func testScoopsListBecomesTheSnapshot() throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "trieloff's Chrome")
        observer.route(scoopsList())

        let snapshot = try XCTUnwrap(store.read())
        XCTAssertEqual(snapshot.instanceLabel, "trieloff's Chrome")
        XCTAssertEqual(snapshot.units.map(\.id), ["cone", "s1"])
        XCTAssertEqual(snapshot.units.first?.role, .cone)
        XCTAssertEqual(snapshot.units.first?.activity, .thinking)
        XCTAssertEqual(snapshot.brokenCount, 1)
        XCTAssertTrue(snapshot.units.first?.isActive ?? false)
    }

    /// Never the join URL, which is a secret.
    func testTheLabelFallsBackToTheHostAndNeverTheJoinUrl() throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/SECRET", label: nil)
        observer.route(scoopsList())

        let snapshot = try XCTUnwrap(store.read())
        XCTAssertEqual(snapshot.instanceLabel, "tray.test")
        XCTAssertFalse(snapshot.instanceLabel.contains("SECRET"))
    }

    func testASnapshotMessageBecomesThePreviewFlattened() throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        observer.route(scoopsList())

        let message = LeaderToFollowerMessage.snapshot(
            messages: [
                ChatMessage(
                    id: "1", role: .assistant,
                    content: "**Done** — see [the PR](https://x.test)\n\n```\ncode\n```",
                    timestamp: 1_787_000_000_000)
            ],
            scoopJid: "cone")
        observer.route(try JSONEncoder().encode(message))

        let last = try XCTUnwrap(store.read()?.lastMessage)
        XCTAssertEqual(last.text, "Done — see the PR")
        XCTAssertEqual(last.author, .agent)
        XCTAssertEqual(last.unitId, "cone")
    }

    /// Half a sentence on a desktop reads as a bug.
    func testAStreamingTurnIsNotThePreview() throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        observer.route(scoopsList())
        observer.route(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.snapshot(
                    messages: [
                        ChatMessage(id: "1", role: .assistant, content: "settled", timestamp: 1000),
                        ChatMessage(
                            id: "2", role: .assistant, content: "half a sen", timestamp: 2000,
                            isStreaming: true),
                    ], scoopJid: "cone")))

        XCTAssertEqual(store.read()?.lastMessage?.text, "settled")
    }

    func testGarbageOnTheWireIsIgnoredRatherThanFatal() throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        observer.route(scoopsList())
        let before = store.read()

        observer.route(Data("not json".utf8))
        observer.route(try JSONEncoder().encode(["type": "something-else"]))

        XCTAssertEqual(store.read(), before)
    }

    func testStoppingForgetsTheWireStateSoAReconnectStartsClean() throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        observer.route(scoopsList())
        XCTAssertEqual(store.read()?.units.count, 2)

        observer.stop()
        observer.leaderChanged(joinUrl: "https://tray.test/join/y", label: "Other")
        observer.route(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.scoopsList(scoops: [], activeScoopJid: "")))

        XCTAssertEqual(store.read()?.units.count, 0)
        XCTAssertEqual(store.read()?.instanceLabel, "Other")
    }
}

/// The launcher's own `ScoopSummary` → `WidgetUnit` mapping.
final class SliccstartWidgetUnitTests: XCTestCase {
    private func summary(
        isCone: Bool? = false, parentId: String? = "cone", state: String? = "working",
        activity: String? = nil, trigger: String? = nil
    ) -> ScoopSummary {
        ScoopSummary(
            jid: "j", name: "folder", folder: "/", isCone: isCone, assistantLabel: "Label",
            trigger: trigger, state: state, activity: activity, fill: 50, parentId: parentId)
    }

    func testTheOwnershipEdgeDecidesTheRole() {
        XCTAssertEqual(summary().widgetUnit(isActive: false).role, .scoop)
        XCTAssertEqual(
            summary(isCone: true, parentId: nil).widgetUnit(isActive: false).role, .cone)
        XCTAssertEqual(
            summary(isCone: false, parentId: nil).widgetUnit(isActive: false).role, .scoop)
    }

    /// #2358: a leader that saw Sliccstart announce protocol version 8 sends no
    /// `isCone` at all. The edge alone must still place the unit — and the
    /// widget must not silently turn every scoop into a cone.
    func testRoleResolvesFromTheEdgeWhenIsConeIsAbsent() throws {
        XCTAssertEqual(
            summary(isCone: nil, parentId: nil).widgetUnit(isActive: false).role, .cone)
        XCTAssertEqual(
            summary(isCone: nil, parentId: "cone").widgetUnit(isActive: false).role, .scoop)

        let decoded = try JSONDecoder().decode(
            ScoopSummary.self,
            from: Data(
                #"{"jid":"j","name":"folder","folder":"/","assistantLabel":"Label","parentId":"cone"}"#
                    .utf8))
        XCTAssertNil(decoded.isCone)
        XCTAssertEqual(decoded.widgetUnit(isActive: false).role, .scoop)
    }

    func testUnknownWireValuesDegradeTheUnitNotTheSnapshot() {
        let unit = summary(state: "hibernating", activity: "vibing").widgetUnit(isActive: false)
        XCTAssertEqual(unit.lifecycle, .unknown)
        XCTAssertNil(unit.activity)
    }

    func testTheTriggerIsFlattenedAndTruncated() {
        let long = "**fix** " + String(repeating: "and more ", count: 60)
        let unit = summary(trigger: long).widgetUnit(isActive: false)
        XCTAssertLessThanOrEqual(unit.detail?.count ?? 0, 120)
        XCTAssertEqual(unit.detail?.hasPrefix("fix and more"), true)
    }
}
