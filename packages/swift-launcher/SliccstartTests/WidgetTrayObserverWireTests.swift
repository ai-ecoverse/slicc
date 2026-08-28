import Foundation
import SliccTrayFollower
import SliccWidgetKit
import XCTest

@testable import Sliccstart

/// The observer's `TrayFollowerConnectorDelegate` half: what it does when the
/// data channel opens, drops, or delivers a frame.
///
/// `WidgetTrayObserverTests` covers when the launcher dials at all (the
/// widget-installation gate). This covers what happens on the wire once it
/// has — the connection lifecycle, the message types the widget depends on,
/// and the transcript-fetch throttle that keeps a busy session from moving
/// more bytes than everything else the observer does combined.
@MainActor
final class WidgetTrayObserverWireTests: XCTestCase {
    private var container: URL!
    private var store: WidgetSnapshotStore!

    override func setUp() async throws {
        container = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("widget-wire-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        store = WidgetSnapshotStore(appGroup: "test") { [container] _ in container! }
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: container)
    }

    private func makeObserver() -> WidgetTrayObserver {
        WidgetTrayObserver(
            publisher: WidgetSnapshotPublisher(store: store, minimumInterval: 0),
            installation: WidgetInstallationQuery { true },
            makeConnector: { _ in StubWireConnector() }
        )
    }

    /// The delegate methods take the concrete connector but never read it —
    /// constructing one dials nothing, so it is a safe stand-in.
    private func connectorStandIn() -> TrayFollowerConnector {
        TrayFollowerConnector(joinUrl: URL(string: "https://tray.test/join/x")!)
    }

    private func encode(_ message: LeaderToFollowerMessage) throws -> Data {
        try JSONEncoder().encode(message)
    }

    private func scoopsList(active: String = "cone") throws -> Data {
        try encode(
            .scoopsList(
                scoops: [
                    ScoopSummary(
                        jid: "cone", name: "cone", folder: "/", isCone: true,
                        assistantLabel: "Sliccy", state: "working", activity: "thinking", fill: 30,
                        parentId: nil)
                ],
                activeScoopJid: active))
    }

    private func chatMessage(
        id: String = "1",
        role: MessageRole,
        content: String,
        timestamp: Double = 1_800_000_000_000
    ) -> ChatMessage {
        ChatMessage(id: id, role: role, content: content, timestamp: timestamp)
    }

    // MARK: - Connection lifecycle

    func testOpeningTheChannelIntroducesTheFollowerAsReadOnly() throws {
        let observer = makeObserver()
        var sent: [Data] = []
        observer.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })

        // The hello is posted from a hop to the main actor.
        let hello = expectation(description: "hello sent")
        Task { @MainActor in hello.fulfill() }
        wait(for: [hello], timeout: 2)

        XCTAssertEqual(sent.count, 1, "connecting must introduce this follower exactly once")
        let decoded = try XCTUnwrap(
            try? JSONSerialization.jsonObject(with: XCTUnwrap(sent.first)) as? [String: Any]
        )
        XCTAssertEqual(decoded["type"] as? String, "hello")
        XCTAssertEqual(
            decoded["runtime"] as? String,
            "sliccstart-widget",
            "the widget follower must identify itself so a leader can tell it apart"
        )
    }

    func testDisconnectingMarksTheSnapshotDisconnected() async throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()
        observer.connector(connectorStandIn(), didConnect: { _ in true })
        await settleMainActor()
        XCTAssertEqual(store.read()?.connection, .connected)

        observer.connectorDidDisconnect(connectorStandIn(), reason: "channel closed")
        await settleMainActor()
        XCTAssertEqual(
            store.read()?.connection,
            .disconnected,
            "a widget must not keep claiming a live session after the channel drops"
        )
    }

    func testGivingUpIsJustADisconnect() async throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()
        observer.connector(connectorStandIn(), didConnect: { _ in true })
        await settleMainActor()

        observer.connector(connectorStandIn(), didGiveUp: "no route to host")
        await settleMainActor()
        XCTAssertEqual(store.read()?.connection, .disconnected)
    }

    func testReconnectAndInfoCallbacksAreDeliberateNoOps() async throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()
        observer.connector(connectorStandIn(), didConnect: { _ in true })
        await settleMainActor()
        let before = store.read()

        // Retrying and the tray's participant census say nothing about what
        // the widget prints, so neither may disturb the snapshot.
        observer.connector(connectorStandIn(), isReconnecting: 3)
        observer.connector(connectorStandIn(), didReceiveInfo: "tray-1", participantCount: 4)
        await settleMainActor()

        XCTAssertEqual(store.read()?.connection, before?.connection)
        XCTAssertEqual(store.read()?.units.count, before?.units.count)
    }

    func testDataArrivingOnTheChannelIsRouted() async throws {
        let observer = makeObserver()
        observer.leaderChanged(joinUrl: "https://tray.test/join/x", label: "Chrome")
        await observer._testing_settle()

        observer.connector(connectorStandIn(), didReceiveData: try scoopsList())
        await settleMainActor()

        // The cone renders under its assistant label, not its jid.
        XCTAssertEqual(store.read()?.units.first?.name, "Sliccy")
    }

    // MARK: - Wire messages

    func testAPingIsAnsweredWithAPong() async throws {
        let observer = makeObserver()
        var sent: [Data] = []
        observer.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settleMainActor()
        sent.removeAll()

        observer.route(try encode(.ping))
        let pong = try XCTUnwrap(sent.first)
        XCTAssertEqual(
            (try? JSONSerialization.jsonObject(with: pong) as? [String: Any])?["type"] as? String,
            "pong",
            "an unanswered ping is how a leader decides this follower is gone"
        )
    }

    func testAChunkedSnapshotIsReassembledBeforeItIsRead() throws {
        let observer = makeObserver()
        let messages = [chatMessage(role: .assistant, content: "the whole answer")]
        struct Payload: Encodable { let messages: [ChatMessage] }
        let payload = try JSONEncoder().encode(Payload(messages: messages))
        let json = String(decoding: payload, as: UTF8.self)
        let half = json.index(json.startIndex, offsetBy: json.count / 2)

        observer.route(
            try encode(
                .snapshotChunk(
                    chunkData: String(json[json.startIndex..<half]),
                    chunkIndex: 0,
                    totalChunks: 2,
                    scoopJid: "cone")))
        XCTAssertNil(store.read()?.lastMessage, "half a snapshot is not a snapshot")

        observer.route(
            try encode(
                .snapshotChunk(
                    chunkData: String(json[half...]),
                    chunkIndex: 1,
                    totalChunks: 2,
                    scoopJid: "cone")))
        XCTAssertEqual(store.read()?.lastMessage?.text, "the whole answer")
    }

    func testAnUndecodableReassembledSnapshotIsDroppedNotCrashed() throws {
        let observer = makeObserver()
        observer.route(
            try encode(.snapshotChunk(chunkData: "{not json", chunkIndex: 0, totalChunks: 1, scoopJid: "cone")))
        XCTAssertNil(store.read()?.lastMessage)
    }

    func testATurnEndingAsksForAFreshTranscript() async throws {
        let observer = makeObserver()
        var sent: [Data] = []
        observer.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settleMainActor()
        sent.removeAll()

        observer.route(try encode(.agentEvent(event: .turnEnd(messageId: "m1"), scoopJid: "cone")))
        XCTAssertEqual(
            (try? JSONSerialization.jsonObject(with: XCTUnwrap(sent.first)) as? [String: Any])?[
                "type"] as? String,
            "request_snapshot"
        )

        // ...but only once per interval: a snapshot is the WHOLE transcript,
        // and a busy session ends turns far faster than that is worth.
        sent.removeAll()
        observer.route(try encode(.agentEvent(event: .turnEnd(messageId: "m1"), scoopJid: "cone")))
        XCTAssertTrue(sent.isEmpty, "the transcript fetch must be throttled")
    }

    func testSwitchingScoopsBeatsTheThrottle() async throws {
        let observer = makeObserver()
        var sent: [Data] = []
        observer.connector(
            connectorStandIn(),
            didConnect: { data in
                sent.append(data)
                return true
            })
        await settleMainActor()

        observer.route(try scoopsList(active: "cone"))
        sent.removeAll()
        // A different active scoop means the transcript on screen is the wrong
        // one, so this fetch is not the throttle's business.
        observer.route(try scoopsList(active: "s1"))
        XCTAssertFalse(sent.isEmpty, "an active-scoop change must refetch immediately")
    }

    func testAnEmptyOrStreamingSnapshotLeavesThePreviewAlone() throws {
        let observer = makeObserver()
        observer.route(try encode(.snapshot(messages: [], scoopJid: "cone")))
        XCTAssertNil(store.read()?.lastMessage)

        observer.route(
            try encode(.snapshot(messages: [chatMessage(role: .assistant, content: "   ")], scoopJid: "cone")))
        XCTAssertNil(store.read()?.lastMessage, "a whitespace-only reply is not a preview")
    }

    func testAUserMessageIsAttributedToTheUser() throws {
        let observer = makeObserver()
        observer.route(
            try encode(.snapshot(messages: [chatMessage(role: .user, content: "do the thing")], scoopJid: "cone")))
        let snapshot = try XCTUnwrap(store.read()?.lastMessage)
        XCTAssertEqual(snapshot.text, "do the thing")
        XCTAssertEqual(snapshot.author, .user)
        XCTAssertNil(snapshot.unitId, "a user message belongs to no unit")
    }

    /// Let the main actor drain the delegate callbacks' `Task { @MainActor }`
    /// hops before asserting.
    private func settleMainActor() async {
        for _ in 0..<3 { await Task.yield() }
    }
}

/// Never dials anything; the wire tests drive the delegate methods directly.
@MainActor
private final class StubWireConnector: WidgetTrayConnecting {
    weak var delegate: TrayFollowerConnectorDelegate?
    func start() async throws {}
    func stop() {}
}
