import Foundation
import SliccTrayFollower
import SliccWidgetKit
import WebRTC
import WidgetKit
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "WidgetTrayObserver")

/// Sliccstart's half of the widget contract: a read-only tray follower whose
/// entire job is to keep `widget-snapshot.json` current.
///
/// The launcher holds no cone or scoop state of its own — SLICC is
/// browser-first and the local server is a stateless relay, so it does not
/// know what the agents are doing either. The only honest source is the same
/// wire every other follower uses, which is why this exists at all.
///
/// It is **gated on the widget actually being installed**
/// (``WidgetInstallationQuery``). No widget on a desktop or in Notification
/// Centre means no connection: a launcher that quietly held a WebRTC
/// participant slot open forever, showing up in the tray's participant count
/// and burning battery, in order to feed a tile nobody added, would be a bad
/// citizen in someone else's session.
@MainActor
final class WidgetTrayObserver: NSObject {
    private let publisher: WidgetSnapshotPublisher
    private let installation: WidgetInstallationQuery
    private let makeConnector: (URL) -> WidgetTrayConnecting

    private var connector: WidgetTrayConnecting?
    /// The in-flight attach. Held so a second `refresh()` cannot start a
    /// parallel dial while the first is still asking WidgetKit whether a
    /// widget exists — and so a test can wait for it without sleeping.
    private var startTask: Task<Void, Never>?
    private var sendData: ((Data) -> Bool)?
    private var reassembler = TrayChunkReassembler()

    /// The instance this observer is attached to.
    private var joinUrl: URL?
    private var label: String?

    /// Latest wire state, kept so a snapshot can be rebuilt when either half
    /// changes without waiting for the other.
    private var scoops: [ScoopSummary] = []
    private var activeScoopJid: String?
    private var lastMessage: WidgetMessage?
    private var connected = false
    /// Per-unit recency, which the wire does not carry — the widget orders by
    /// it, so the capture side has to observe change itself.
    private var recency = UnitRecencyLedger()

    /// App-level snapshot chunking (`snapshot_chunk`), which is distinct from
    /// the transport framing the reassembler handles.
    private var snapshotChunks: [Int: String] = [:]
    private var snapshotTotalChunks = 0
    /// Throttles transcript re-fetches. A snapshot is the WHOLE transcript;
    /// asking for one per turn on a busy session would move more bytes than
    /// everything else this observer does combined.
    private var lastSnapshotRequest: Date?
    private let snapshotRequestInterval: TimeInterval = 30

    init(
        publisher: WidgetSnapshotPublisher? = nil,
        installation: WidgetInstallationQuery = .default,
        makeConnector: @escaping (URL) -> WidgetTrayConnecting = { TrayFollowerConnector(joinUrl: $0) }
    ) {
        // Not a default argument: the publisher is `@MainActor`, and a default
        // argument is evaluated in the caller's isolation, which the compiler
        // cannot prove is the main actor.
        self.publisher = publisher ?? WidgetSnapshotPublisher(store: WidgetHost.sliccstart.store)
        self.installation = installation
        self.makeConnector = makeConnector
        super.init()
    }

    /// Follow a new leader, or stop following when there is none.
    ///
    /// Called from the same place the File Provider coordinator is —
    /// `leaderJoinUrl` is the launcher's one piece of session identity.
    func leaderChanged(joinUrl rawJoinUrl: String?, label: String?) {
        let url = rawJoinUrl.flatMap(URL.init(string:))
        guard url?.absoluteString != joinUrl?.absoluteString || url == nil else { return }
        self.label = label
        stop()
        joinUrl = url
        guard url != nil else {
            // No leader means no instance to name. The widget says so rather
            // than keeping the last one it saw.
            publisher.clear()
            return
        }
        refresh()
    }

    /// Re-check installation and connect if a widget has appeared since the
    /// last look. Cheap enough to call on a timer or on activation.
    func refresh() {
        guard startTask == nil else { return }
        startTask = Task { @MainActor [weak self] in
            await self?.startIfWidgetInstalled()
            self?.startTask = nil
        }
    }

    /// Test hook: wait out the in-flight attach instead of yielding and hoping.
    func _testing_settle() async {
        await startTask?.value
    }

    func stop() {
        startTask?.cancel()
        startTask = nil
        connector?.stop()
        connector = nil
        sendData = nil
        connected = false
        scoops = []
        activeScoopJid = nil
        lastMessage = nil
        snapshotChunks.removeAll()
        reassembler = TrayChunkReassembler()
        // A fresh leader is a fresh session: carrying stamps across would let
        // a unit from the old one keep a position it did not earn.
        recency = UnitRecencyLedger()
    }

    private func startIfWidgetInstalled() async {
        guard connector == nil, let url = joinUrl else { return }
        guard await installation.isInstalled() else {
            log.debug("No Cones & Scoops widget installed — not dialing the leader")
            return
        }
        let connector = makeConnector(url)
        connector.delegate = self
        self.connector = connector
        do {
            try await connector.start()
        } catch {
            log.error("Widget tray observer could not attach: \(String(describing: error))")
            self.connector = nil
        }
    }

    // MARK: - Snapshot

    private func publish() {
        let now = Date()
        let units = scoops.map { $0.widgetUnit(isActive: $0.jid == activeScoopJid) }
        publisher.publish(
            WidgetSnapshot(
                instanceLabel: instanceLabel,
                runtime: nil,
                connection: connected ? .connected : .disconnected,
                capturedAt: now,
                units: recency.stamp(units, now: now),
                lastMessage: lastMessage))
    }

    /// Never the join URL, which is a secret.
    private var instanceLabel: String {
        let named = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !named.isEmpty { return named }
        if let host = joinUrl?.host, !host.isEmpty { return host }
        return "SLICC"
    }

    // MARK: - Wire

    private func send(_ message: FollowerToLeaderMessage) -> Bool {
        guard let sendData, let data = try? JSONEncoder().encode(message) else { return false }
        return sendData(data)
    }

    private func requestSnapshotIfDue(force: Bool = false) {
        let now = Date()
        if !force, let last = lastSnapshotRequest,
            now.timeIntervalSince(last) < snapshotRequestInterval
        {
            return
        }
        lastSnapshotRequest = now
        _ = send(.requestSnapshot(scoopJid: activeScoopJid))
    }

    func route(_ data: Data) {
        struct Envelope: Decodable { let type: String }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return }
        if envelope.type == TrayChunkFrame.typeTag {
            guard let frame = try? JSONDecoder().decode(TrayChunkFrame.self, from: data),
                let message = reassembler.accept(frame).message
            else { return }
            route(message)
            return
        }
        guard let message = try? JSONDecoder().decode(LeaderToFollowerMessage.self, from: data)
        else { return }
        switch message {
        case .scoopsList(let scoops, let activeScoopJid):
            let activeChanged = activeScoopJid != self.activeScoopJid
            self.scoops = scoops
            self.activeScoopJid = activeScoopJid
            publish()
            requestSnapshotIfDue(force: activeChanged)
        case .snapshot(let messages, _):
            ingest(messages: messages)
        case .snapshotChunk(let chunkData, let chunkIndex, let totalChunks, _):
            snapshotTotalChunks = totalChunks
            snapshotChunks[chunkIndex] = chunkData
            guard snapshotChunks.count == totalChunks else { return }
            let json = (0..<totalChunks).compactMap { snapshotChunks[$0] }.joined()
            snapshotChunks.removeAll()
            struct Payload: Decodable { let messages: [ChatMessage] }
            guard let payload = try? JSONDecoder().decode(Payload.self, from: Data(json.utf8))
            else { return }
            ingest(messages: payload.messages)
        case .agentEvent(let event, _):
            // A finished turn is the only event that changes what the widget
            // would print, and it is the moment worth spending a fetch on.
            if case .turnEnd = event { requestSnapshotIfDue() }
        case .ping:
            _ = send(.pong)
        default:
            break
        }
    }

    private func ingest(messages: [ChatMessage]) {
        guard
            let last = messages.last(where: {
                $0.isStreaming != true && !WidgetMessage.flatten(markdown: $0.content).isEmpty
            })
        else { return }
        lastMessage = WidgetMessage(
            author: last.role == .user ? .user : .agent,
            unitId: last.role == .user ? nil : activeScoopJid,
            text: WidgetMessage.flatten(markdown: last.content),
            at: Date(timeIntervalSince1970: last.timestamp / 1000))
        publish()
    }
}

// MARK: - Connector seam

/// The slice of `TrayFollowerConnector` this observer uses, so its wiring is
/// testable without a leader, a network or WebRTC.
@MainActor
protocol WidgetTrayConnecting: AnyObject {
    var delegate: TrayFollowerConnectorDelegate? { get set }
    func start() async throws
    func stop()
}

extension TrayFollowerConnector: WidgetTrayConnecting {}

extension WidgetTrayObserver: TrayFollowerConnectorDelegate {
    nonisolated func connector(
        _ connector: TrayFollowerConnector, didConnect channelSend: @escaping (Data) -> Bool
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            sendData = channelSend
            connected = true
            // `read-only`: this follower never sends a user message, never
            // selects a scoop and never steers. It listens.
            _ = send(
                .hello(
                    protocolVersion: traySyncProtocolVersion,
                    runtime: "sliccstart-widget",
                    capabilities: nil,
                    motd: nil))
            publish()
        }
    }

    nonisolated func connectorDidDisconnect(_ connector: TrayFollowerConnector, reason: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            sendData = nil
            connected = false
            publish()
        }
    }

    nonisolated func connector(_ connector: TrayFollowerConnector, isReconnecting attempt: Int) {}

    nonisolated func connector(_ connector: TrayFollowerConnector, didGiveUp lastError: String) {
        connectorDidDisconnect(connector, reason: lastError)
    }

    nonisolated func connector(
        _ connector: TrayFollowerConnector, didReceiveInfo trayId: String, participantCount: Int
    ) {}

    nonisolated func connector(
        _ connector: TrayFollowerConnector, didGenerateCandidate candidate: RTCIceCandidate
    ) {}

    nonisolated func connector(_ connector: TrayFollowerConnector, didReceiveData data: Data) {
        Task { @MainActor [weak self] in self?.route(data) }
    }
}

// MARK: - Installation gate

/// Whether the user has actually added a Cones & Scoops widget.
///
/// The whole tray connection hangs off this answer, so it is injectable: a
/// test must be able to say "no widget" without WidgetKit's opinion.
struct WidgetInstallationQuery: Sendable {
    let isInstalled: @Sendable () async -> Bool

    static let `default` = WidgetInstallationQuery {
        await withCheckedContinuation { continuation in
            WidgetCenter.shared.getCurrentConfigurations { result in
                switch result {
                case .success(let widgets):
                    continuation.resume(returning: widgets.contains { $0.kind == UnitsWidget.kind })
                case .failure:
                    // WidgetKit refuses to answer in an unsigned or
                    // un-registered build. Assume nothing is installed rather
                    // than dialing a leader on a maybe.
                    continuation.resume(returning: false)
                }
            }
        }
    }
}

extension ScoopSummary {
    /// The widget's projection of one work unit — the launcher's copy of the
    /// follower's mapping, against the same wire type.
    func widgetUnit(isActive: Bool) -> WidgetUnit {
        WidgetUnit(
            id: jid,
            name: assistantLabel.isEmpty ? name : assistantLabel,
            role: (parentId == nil && isCone) ? .cone : .scoop,
            parentId: parentId,
            lifecycle: WidgetUnit.Lifecycle(rawValue: state ?? "") ?? .unknown,
            activity: activity.flatMap(WidgetUnit.Activity.init(rawValue:)),
            fill: fill,
            model: model?.id,
            detail: trigger.map { String(WidgetMessage.flatten(markdown: $0).prefix(120)) },
            isActive: isActive)
    }
}
