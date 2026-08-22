import Foundation
import SliccTrayKit
import SliccTraySession
import SwiftUI
import WebKit
import WebRTC
import os

/// Represents the current connection state of the follower app.
enum ConnectionState: String {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed
    /// Bounded reconnect ran out of attempts. Terminal and actionable — unlike
    /// `reconnecting`, nothing further happens without the user, and unlike
    /// `failed`, we know the leader was unreachable across the whole backoff.
    case gaveUp
}

/// Bounded exponential backoff for reconnects, mirroring the TS defaults in
/// `startFollowerWithAutoReconnect` (`packages/webapp/src/scoops/tray-webrtc.ts`).
enum ReconnectBackoff {
    static let baseDelay: TimeInterval = 1
    static let multiplier: Double = 2
    static let maxDelay: TimeInterval = 30
    static let maxAttempts = 10

    /// Delay before attempt `attempt` (1-based), capped at `maxDelay`.
    static func delay(forAttempt attempt: Int) -> TimeInterval {
        guard attempt > 1 else { return baseDelay }
        let grown = baseDelay * pow(multiplier, Double(attempt - 1))
        return min(grown, maxDelay)
    }
}

// ChatMessage is defined in SliccTrayKit/Models/ChatMessage.swift

/// Wrapper for decoding chunked snapshot payloads.
/// The leader serializes snapshots as `JSON.stringify({ messages, scoopJid })`.
private struct SnapshotPayload: Codable {
    let messages: [ChatMessage]
    let scoopJid: String
}

/// Global app state shared across views via @EnvironmentObject.
///
/// Central coordinator wiring: TraySignaling → WebRTC → sync → UI.
/// Owns the connection lifecycle, decodes leader messages, and exposes
/// @Published properties for SwiftUI views.
@MainActor
class AppState: ObservableObject {

    // MARK: - Logging

    private let logger = Logger(subsystem: "com.slicc.follower", category: "AppState")

    // MARK: - Published UI State

    @Published var connectionState: ConnectionState = .disconnected {
        didSet { ingestConnectionHealth() }
    }
    @Published var joinUrl: String = ""
    @Published var trayId: String?
    @Published var messages: [ChatMessage] = []
    /// Pending `tool_ui` approvals, oldest first. These live outside the
    /// transcript because the leader mounts them outside the message list too,
    /// so a streaming re-render cannot wipe them.
    @Published var toolUICards: [ToolUIPlaceholder] = []
    @Published var openApprovals: [OpenApprovalRequest] = []
    @Published var openGrants: [OpenGrant] = []
    /// Delegated sudo prompts awaiting this phone's human (#2062).
    @Published var sudoApprovals: [SudoApprovalRequest] = []
    @Published var isStreaming: Bool = false {
        // A turn's streaming edge: starting one clears the wait, ending one
        // starts it. Every writer (turn_end, `status: ready`, the error path,
        // snapshot ingest) funnels through this observer, so no single call
        // site can forget. Kept here because both stores are `private(set)`.
        didSet {
            guard oldValue != isStreaming else { return }
            runningToolCalls = 0
            awaitingUserSince = isStreaming ? nil : Date()
        }
    }

    // MARK: - Agent avatar expression
    //
    // Locally observed signals for the FOCUSED scoop, from streams this
    // follower already mirrors. They outrank the wire's `state` (which now
    // carries `thinking` and `awaiting` too) because they land a broadcast
    // earlier — see `AppState+AvatarExpression.swift` for the derivation.

    /// Tool calls in flight for the VISIBLE scoop — `tool_use_start` opens one,
    /// `tool_result` closes it. A working agent with one open is running a tool
    /// (square eyes); otherwise it is thinking (brows + saccades).
    @Published private(set) var runningToolCalls: Int = 0
    /// When the turn settled and the composer became yours. Drives the avatar's
    /// `awaiting` eye contact and, after 90s, its drowse.
    @Published private(set) var awaitingUserSince: Date?
    /// Shared with the chat header's avatar so hosts can fire transients
    /// (`scrutinize` per keystroke, `glower` on a failed tool call).
    let avatarExpression = AvatarExpressionEngine()

    // Multi-scoop awareness
    /// All scoops the leader has registered (cone first), updated via `scoops.list`.
    @Published var scoops: [ScoopSummary] = []
    /// JID of the scoop this follower is currently viewing (independent from leader's selection).
    @Published var selectedScoopJid: String?
    /// JID of the leader's currently active scoop (informational; used to mark the active row).
    @Published var leaderActiveScoopJid: String?

    // Model selection is global; thinking selection is scoped to the follower's
    // currently selected scoop. These remain empty until a v5+ hello arrives.
    @Published private(set) var leaderProtocolVersion: Int?
    @Published private(set) var modelCatalog: [TrayModelCatalogEntry] = []
    @Published private(set) var modelSelectionState: TrayModelSelectionState?

    /// Whether a message typed now lands where the user is looking. A
    /// scoop-less `user_message` routes to the LEADER's active scoop, so a
    /// follower viewing a different scoop must not be offered actions —
    /// like steering — that would hit the wrong turn. Unknown state
    /// (either side nil) errs permissive: pre-scoop leaders have exactly
    /// one target.
    var composerTargetsLeaderActiveScoop: Bool {
        guard let selected = selectedScoopJid, let active = leaderActiveScoopJid else {
            return true
        }
        return selected == active
    }
    /// Per-scoop message buffers. Source of truth for `messages`.
    /// Internal (not private) so the delivery extension can flag a failed
    /// send in the buffer too.
    var messagesByScoop: [String: [ChatMessage]] = [:]
    /// Live tool-call progress units, keyed by the tool row's id (see
    /// `AppState.toolRowId`). Only in-flight calls appear here — a `tool_result`
    /// or a `phase == .end` tick removes the entry, the turn that owns a row
    /// clears it when it ends, a snapshot drops whatever it replaced, and a
    /// session reset clears the lot, so a stale bar can never outlive the run
    /// that painted it. The map spans scoops (row ids are message-scoped, so
    /// they cannot collide), which is what lets a background scoop keep its
    /// bars while you read another one. Read through `MessageListView`.
    @Published var toolProgress: [String: ToolProgressEvent] = [:]

    // Sprinkle awareness
    @Published var sprinkles: [SprinkleSummary] = []
    /// In-memory cache of fetched sprinkle .shtml content keyed by sprinkle name.
    @Published var sprinkleContents: [String: String] = [:]
    /// Pending fetch requests waiting for chunked content; keyed by requestId.
    private var pendingSprinkleFetches: [String: SprinkleFetchBuffer] = [:]
    /// Inflight requestIds keyed by sprinkleName, used to dedupe concurrent fetches.
    private var inflightSprinkleNameToRequest: [String: String] = [:]
    /// Continuations awaiting sprinkle content (sprinkleName -> [continuations]).
    private var sprinkleContentWaiters: [String: [CheckedContinuation<String, Error>]] = [:]
    /// Requester for `fs.*` ops against the **leader's** VFS. Lazy so the send
    /// closure can reference `self` after initialization completes.
    private(set) lazy var fsClient = FsClient { [weak self] message in
        self?.sendToLeader(message) ?? false
    }
    /// Single-flight client for commands running in the leader's virtual shell.
    private(set) lazy var terminalClient = TerminalClient { [weak self] in
        self?.sendToLeader($0) ?? false
    }
    private(set) lazy var openApprovalController = makeOpenApprovalController()
    private(set) lazy var sudoApprovalController = makeSudoApprovalController()
    /// Follower-originated CDP for tab previews (#1865).
    private(set) lazy var cdpPreviews = CdpPreviewClient { [weak self] message in
        self?.sendToLeader(message) ?? false
    }
    /// What the leader advertised on `hello`. Published because negotiated
    /// capabilities gate follower surfaces such as the leader-backed Terminal.
    @Published private(set) var leaderCapabilities: TraySyncCapabilities?
    private(set) var leaderMotd: String?
    /// Payload identities of handoffs already forwarded this session, so a
    /// site emitting the same `Link` on every page produces one lick rather
    /// than one per navigation. Mirrors the web watcher's dedup.
    private var seenHandoffFingerprints: Set<String> = []
    /// Most recent sprinkle update payloads keyed by sprinkle name. Drained by views.
    @Published var sprinkleUpdates: [String: AnyCodable] = [:]
    /// Monotonic reload generation per sprinkle; bumped on `sprinkle.reloaded`.
    @Published var sprinkleReloadGeneration: [String: Int] = [:]

    // Connection metadata (populated after successful connect)
    @Published var leaderConnected: Bool = false
    @Published var participantCount: Int = 0
    @Published var connectedSince: Date?
    @Published var autoReconnect: Bool = true

    /// Last *transport* error, surfaced to the UI. A dropped channel, a refused
    /// signaling attempt, an exhausted reconnect. Kept apart from `leaderError`
    /// so a network blip and a cone failure do not read identically.
    @Published var lastError: String?
    /// The leader's active theme (`theme.apply`), nil when unthemed — the
    /// phone then follows the system scheme like the unthemed webapp shell.
    @Published var leaderTheme: SliccTheme?

    /// Last error reported *by the leader's agent*. A cone problem, not a
    /// transport problem: reconnecting cannot fix it and the UI must not offer
    /// that as the remedy.
    @Published var leaderError: String?

    /// The leader stopped answering pings while its channel stayed open. The
    /// connection is intact and probing continues; the peer is just busy.
    /// Sending is blocked so a message typed now cannot be lost — the composer
    /// stays typable regardless (see `InputBar`).
    @Published var isLeaderStalled: Bool = false {
        didSet { ingestConnectionHealth() }
    }

    /// Which reconnect attempt is in flight, 1-based. Zero when not reconnecting.
    @Published var reconnectAttempt: Int = 0 {
        didSet { ingestConnectionHealth() }
    }

    // MARK: - Settled connection

    /// The transport as the chat surface is allowed to describe it: the raw
    /// state, held back across the settle window on its way into trouble so a
    /// WebRTC blip that heals never reaches the avatar or the composer. Reads
    /// identically to the raw state whenever the link is steady.
    ///
    /// Every connection-driven treatment on the chat surface reads THIS, never
    /// the raw properties, or the parts would disagree during the hold. Gates
    /// that are about capability rather than appearance (can this surface talk
    /// to the leader at all) stay on the raw state, as does `MonitorView`,
    /// which exists to report what is actually happening.
    @Published private(set) var settledConnection = ConnectionHealth(state: .disconnected)

    /// Eager, not lazy: the first transport transition arrives through a
    /// `didSet`, and a settler built at that moment would be born already
    /// holding the value it was supposed to weigh — publishing nothing, ever.
    ///
    /// Internal rather than private, like `connectionIngestSuspended`: stored
    /// properties cannot live in an extension, but everything that reads them
    /// does — see `AppState+Connection.swift`.
    let connectionSettler = ConnectionSettler(
        initial: ConnectionHealth(state: .disconnected))

    /// True while `updateConnection` is composing one reading out of several
    /// property writes.
    var connectionIngestSuspended = false

    /// Buffer for chunked sprinkle.content responses.
    private struct SprinkleFetchBuffer {
        let sprinkleName: String
        var chunks: [Int: String] = [:]
        var totalChunks: Int = 1
    }

    // MARK: - Init

    /// Tray sessions other devices published to iCloud KVS (the macOS
    /// launcher is the producer). Read-only here: the phone joins sessions,
    /// it never publishes one. `@Observable`, so SwiftUI views track it
    /// directly; without iCloud provisioning it degrades to a local cache
    /// and simply stays empty.
    let sessionStore: TraySessionSyncStore
    /// Join URLs that actually connected — from this device or any other on
    /// the same Apple ID. Publishing them is the only way a hand-pasted URL
    /// (which no launcher ever advertised) reaches a second device.
    let recentJoinStore: RecentJoinStore
    private let credentialStore: TrayCredentialStore
    private let fileProviderDomainLifecycle: FileProviderDomainLifecycle
    let openGrantStore: OpenGrantStore

    init(
        credentialStore: TrayCredentialStore = TrayCredentialStore(),
        fileProviderDomainLifecycle: FileProviderDomainLifecycle = FileProviderDomainLifecycle(),
        openGrantStore: OpenGrantStore = OpenGrantStore()
    ) {
        sessionStore = AppState.makeSessionStore()
        recentJoinStore = AppState.makeRecentJoinStore()
        self.credentialStore = credentialStore
        self.fileProviderDomainLifecycle = fileProviderDomainLifecycle
        self.openGrantStore = openGrantStore
        openGrants = openGrantStore.grants
        connectionSettler.onChange = { [weak self] health in
            self?.settledConnection = health
        }
        Self.purgeLegacyJoinURLDefaults()
        fileProviderDomainLifecycle.registerIfCredentialsAvailable(credentialStore.load() != nil)
        #if DEBUG
            if let fixtureScoops = UITestHooks.scoopStatusFixture() {
                scoops = fixtureScoops
                selectedScoopJid = fixtureScoops.first?.jid
                leaderActiveScoopJid = fixtureScoops.first?.jid
            }
            configureOpenApprovalFixture()
            configureSudoApprovalFixture()
        #endif
        wireNotificationActions()
    }

    // MARK: - Private Networking / Sync

    // These are fileprivate so WebRTCBridge (same file) can access them.
    fileprivate var signalingClient: TraySignalingClient?
    private var webRTCManager: WebRTCManager?
    private var webRTCDelegate: WebRTCBridge?
    private var keepalive: DataChannelKeepalive?
    private var connectTask: Task<Void, Never>?
    /// Owns the bounded reconnect budget. Separate from `connectTask`, which
    /// `tearDown()` cancels on every attempt — cancelling the loop from inside
    /// its own retry would end the budget after one try.
    private var reconnectTask: Task<Void, Never>?
    fileprivate var controllerId: String = UUID().uuidString
    fileprivate var currentBootstrapId: String?

    /// Snapshot chunks being accumulated for reassembly.
    private var snapshotChunks: [Int: String] = [:]
    private var snapshotTotalChunks: Int = 0
    /// Reassembles oversize messages arriving as transport chunk frames.
    private var chunkReassembler = TrayChunkReassembler()

    /// ID of the message currently being streamed.
    private(set) var streamingMessageId: String?

    /// Coalesces high-frequency `messages` republishes during streaming so a
    /// burst of contentDeltas doesn't peg the SwiftUI render loop and starve
    /// touch handling (notably the Settings sheet's Done button while the
    /// underlying chat view is observing the same AppState).
    private var pendingMessagesFlush: Task<Void, Never>?

    // MARK: - CDP / federated targets

    /// CDP bridge — owns WKWebViews, dispatches CDP commands.
    private var cdpBridge: CDPBridge?
    /// Periodic timer for re-advertising targets.
    private var targetsAdvertiseTimer: Timer?
    /// Visible list of locally-hosted CDP targets (one per WKWebView).
    @Published var cdpTargets: [CDPTargetSummary] = []
    /// Federated tabs elsewhere in the tray (`targets.registry`, own
    /// runtime excluded) — the browser surface's preview cards.
    @Published var remoteTargets: [TrayTargetEntry] = []
    /// The local tab the browser surface shows full screen; nil means the
    /// tab overview grid. Published because the shell reacts too: full
    /// screen hides the dock rail and the navigation bar.
    @Published var browserViewingTabId: String?
    /// A tab the LEADER just opened here. Published so the shell can bring it
    /// to the front: before this, `tab.open` created a WKWebView target the
    /// user never saw, so a teleported login sat waiting behind the chat with
    /// nothing to indicate it existed. The shell clears it once presented.
    @Published var leaderOpenedTabId: String?

    // MARK: - Connection Lifecycle

    /// The URL of the session currently being dialed. Manual connects copy it
    /// from the Join URL field; discovered sessions set it directly so the
    /// secret-bearing URL never surfaces in the field, the persisted setting,
    /// or the visible history. Reconnects reuse it.
    private var activeJoinUrl: String = ""
    var activeDisplayName: String?

    // MARK: - Frozen sessions (freezer rail)

    /// Single-flight guard for `new_session`: the leader runs its own
    /// guard, but the phone must not queue a second request while a save
    /// (the slow, LLM-enriched path) is in flight. Cleared when the
    /// leader's cleared snapshot arrives, with a timeout backstop.
    @Published var newSessionInFlight = false
    private var newSessionTimeout: Task<Void, Never>?

    @Published var frozenListState: FrozenListState = .idle
    @Published var frozenSessions: [FrozenSessionIndexEntry] = []
    /// Entry id currently being fetched from the leader, nil when none. The
    /// sheet stays open (showing progress) until the open settles, so a
    /// failed read is seen rather than silently returning to live chat.
    @Published var frozenOpeningId: String?
    /// Non-nil while a frozen session is open read-only; the composer is
    /// replaced by the frozen banner for the duration.
    @Published var openFrozen: OpenFrozenSession?
    @Published var frozenOpenError: String?

    /// Ask the leader to start a new chat. The phone never clears
    /// optimistically — the leader broadcasts the cleared snapshot and
    /// `ingestSnapshot` resets the buffers (and this flag) when it lands.
    func requestNewSession(_ action: NewSessionAction) {
        guard !newSessionInFlight else { return }
        guard sendToLeader(.newSession(action: action)) else { return }
        newSessionInFlight = true
        // `save` runs LLM enrichment and can take a while; the backstop only
        // exists so a dropped reply cannot pin the button forever.
        newSessionTimeout?.cancel()
        newSessionTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 120 * 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.newSessionInFlight = false
        }
    }

    private func connect(to rawUrl: String, displayName: String?) {
        let trimmed = rawUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return }
        guard connectionState != .connecting else { return }

        connectionState = .connecting
        lastError = nil
        // Per-leader state: a new session must not inherit the previous
        // leader's palette. A themed leader re-sends theme.apply on join.
        leaderTheme = nil
        // Recents are recorded on success (`dataChannelOpened`), never here:
        // a typo'd paste must not sync itself to every other device.
        activeJoinUrl = trimmed
        activeDisplayName = displayName

        // Tear down any previous connection first.
        tearDown()

        controllerId = UUID().uuidString
        let client = TraySignalingClient(joinUrl: url)
        signalingClient = client

        let rtc = WebRTCManager()
        webRTCManager = rtc
        let bridge = WebRTCBridge(appState: self)
        webRTCDelegate = bridge
        rtc.delegate = bridge

        connectTask = Task { [weak self] in
            guard let self else { return }
            await self.runSignalingLoop(client: client, rtc: rtc)
        }
    }

    /// Disconnect from the current tray session. Unlike a transient WebRTC
    /// drop this is user-initiated, so we also drop any open CDP tabs.
    func disconnect() {
        // A user-initiated disconnect ends the reconnect budget; otherwise the
        // loop would keep dialing a leader the user just walked away from.
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        clearTrayCredentials()
        fileProviderDomainLifecycle.removeDomain()
        tearDown()
        resetCDPState()
        // Cleared with the state, not before it: on its own the cleared stall
        // reads as a healthy connection (see `updateConnection`).
        updateConnection {
            isLeaderStalled = false
            connectionState = .disconnected
        }
        trayId = nil
        leaderConnected = false
        participantCount = 0
        connectedSince = nil
        isStreaming = false
        streamingMessageId = nil
        // A reply that never arrived must not leave a mark behind to speak
        // the first turn of whatever session comes next; the fresh session
        // also re-arms the one-time dictation priming note.
        VoiceReply.shared.reset()
        DictationPriming.reset()
        scoops = []
        selectedScoopJid = nil
        leaderActiveScoopJid = nil
        leaderProtocolVersion = nil
        modelCatalog = []
        modelSelectionState = nil
        messagesByScoop.removeAll()
        toolProgress.removeAll()
        sprinkles = []
        sprinkleContents.removeAll()
        sprinkleUpdates.removeAll()
        pendingSprinkleFetches.removeAll()
        inflightSprinkleNameToRequest.removeAll()
        // Resolve any pending waiters with an error so callers don't hang.
        let waiters = sprinkleContentWaiters
        sprinkleContentWaiters.removeAll()
        for (_, list) in waiters {
            for waiter in list {
                waiter.resume(throwing: SprinkleFetchError.fetchFailed("Disconnected"))
            }
        }
        // Same contract for fs waiters: fail them rather than let the deadline
        // run out on a channel that is already gone.
        fsClient.cancelAll()
    }

    /// Drop all hosted CDP tabs (called on user-initiated disconnect).
    /// Reconnects after a transient WebRTC drop preserve the bridge so the
    /// user's open tabs survive.
    private func resetCDPState() {
        stopTargetsAdvertiseTimer()
        cdpBridge?.reset()
        cdpBridge = nil
        cdpTargets.removeAll()
        // Per-tray like cdpTargets: a new leader deliberately sends no
        // empty registry, so stale remote tabs would otherwise outlive the
        // tray that owned them.
        remoteTargets.removeAll()
    }

    // MARK: - UI Actions

    /// Send a user message to the agent via the data channel.
    /// `steer: true` interrupts the leader's running turn instead of
    /// queueing behind it — the phone's equivalent of the desktop's
    /// Cmd+Enter.
    func sendMessage(
        _ text: String, steer: Bool = false, attachments: [MessageAttachment]? = nil,
        dictated: Bool = false
    ) {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let attached = (attachments?.isEmpty == false) ? attachments : nil
        // A pure-attachment message is legal (the web composer sends photos
        // with no caption); only an entirely empty send is dropped.
        guard !trimmed.isEmpty || attached != nil else { return }

        // The dictation scoop is resolved up front: the mark has to name the
        // scoop the message goes to, and the same value is used to undo it.
        let dictationScoop = selectedScoopJid ?? ""
        if dictated {
            // Markers are stored AND sent, as the webapp does, so replay and
            // compaction keep the context; bubbles strip them at render time.
            // The first-turn flag is only PEEKED here — a send that never
            // reaches the leader must not burn the one-time priming note.
            trimmed = DictationPriming.applyMarkers(
                trimmed, isFirst: DictationPriming.isFirstPending)
            VoiceReply.shared.markSubmission(scoopJid: dictationScoop)
        }

        let messageId = UUID().uuidString
        let message = ChatMessage(
            id: messageId,
            role: .user,
            content: trimmed,
            timestamp: Date().timeIntervalSince1970 * 1000,
            attachments: attached
        )
        messages.append(message)
        // Mirror into the per-scoop buffer so swipe-back retains the message.
        if let jid = selectedScoopJid {
            messagesByScoop[jid, default: []].append(message)
        }

        let msg = FollowerToLeaderMessage.userMessage(
            text: trimmed, messageId: messageId, steer: steer, attachments: attached)
        #if DEBUG
            // A hermetic UI test forces the connection state with no real
            // channel behind it — extend the same fiction to delivery, or
            // every test send would flag itself undelivered.
            let hermeticallyConnected = UITestHooks.forcedConnectionState != nil
        #else
            let hermeticallyConnected = false
        #endif
        if !sendToLeader(msg), !hermeticallyConnected {
            markUndelivered(messageId)
            // Nothing left, so nothing will answer: retire the mark and keep
            // the priming note armed. Otherwise a reconnect (which runs
            // `handleDisconnect`, not the user-only `disconnect()`) would
            // carry the stale mark forward and speak an unrelated reply.
            if dictated { VoiceReply.shared.rollbackSubmission(scoopJid: dictationScoop) }
        } else if dictated {
            DictationPriming.commitFirst()
        }
    }

    /// Abort the current streaming response.
    func abort() {
        isStreaming = false
        streamingMessageId = nil
        sendToLeader(.abort)
    }

    // MARK: - Sprinkles

    /// Ask the leader to refresh the sprinkle list.
    func refreshSprinkles() {
        sendToLeader(.sprinklesRefresh)
    }

    /// Fetch the raw .shtml content for a sprinkle. Returns cached content
    /// when available, otherwise sends a `sprinkle.fetch` and awaits the
    /// reassembled response. Throws on transport / leader errors.
    func fetchSprinkleContent(_ sprinkleName: String) async throws -> String {
        if let cached = sprinkleContents[sprinkleName] { return cached }
        let requestId = UUID().uuidString
        // Dedupe concurrent fetches for the same sprinkle.
        if inflightSprinkleNameToRequest[sprinkleName] == nil {
            inflightSprinkleNameToRequest[sprinkleName] = requestId
            pendingSprinkleFetches[requestId] = SprinkleFetchBuffer(sprinkleName: sprinkleName)
            sendToLeader(.sprinkleFetch(requestId: requestId, sprinkleName: sprinkleName))
        }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            sprinkleContentWaiters[sprinkleName, default: []].append(continuation)
        }
    }

    /// Forward a navigate lick for a handoff advertised by a page hosted in a
    /// CDP target.
    ///
    /// This is the phone's half of the SLICC handoff flow: a page responds
    /// with a `Link: <…>; rel="…/rel/handoff"` header, and the leader's cone
    /// shows an approval prompt.
    ///
    /// The outcome is reported rather than reduced to a Bool so a suppressed
    /// duplicate stays distinguishable from a send that simply had no leader
    /// to reach — otherwise a broken dedup looks identical to a disconnect.
    enum HandoffForwardResult: Equatable {
        case sent
        case duplicate
        case notDelivered
    }

    @discardableResult
    func forwardNavigateLick(pageURL: String, match: HandoffMatch, title: String?)
        -> HandoffForwardResult
    {
        let fingerprint = Self.handoffFingerprint(match)
        guard seenHandoffFingerprints.insert(fingerprint).inserted else {
            logger.debug("Skipping duplicate handoff for \(match.verb.rawValue)")
            return .duplicate
        }
        let event = LickEvent.navigate(pageURL: pageURL, match: match, title: title)
        return sendToLeader(.lick(event: event)) ? .sent : .notDelivered
    }

    /// Stable identity for a handoff payload, independent of the page that
    /// advertised it. Mirrors `handoffFingerprint` in `handoff-link.ts`: NUL
    /// cannot appear in any part, so joining is collision-free without a hash.
    nonisolated static func handoffFingerprint(_ match: HandoffMatch) -> String {
        [
            match.verb.rawValue, match.target, match.branch ?? "", match.path ?? "",
            match.instruction ?? "",
        ].joined(separator: "\0")
    }

    /// Forward a sprinkle lick (from a panel or inline sprinkle) to the leader.
    func sendSprinkleLick(_ sprinkleName: String, body: AnyCodable?, targetScoop: String? = nil) {
        sendToLeader(
            .sprinkleLick(
                sprinkleName: sprinkleName,
                body: body,
                targetScoop: targetScoop
            ))
    }

    /// Reassemble chunked sprinkle.content responses and resolve waiters.
    private func handleSprinkleContent(
        requestId: String,
        sprinkleName: String,
        content: String,
        chunkIndex: Int?,
        totalChunks: Int?,
        error: String?
    ) {
        if let error = error {
            logger.error("sprinkle.content error for \(sprinkleName): \(error)")
            pendingSprinkleFetches.removeValue(forKey: requestId)
            inflightSprinkleNameToRequest.removeValue(forKey: sprinkleName)
            let waiters = sprinkleContentWaiters.removeValue(forKey: sprinkleName) ?? []
            for waiter in waiters {
                waiter.resume(throwing: SprinkleFetchError.fetchFailed(error))
            }
            return
        }

        let assembled: String?
        if let chunkIndex = chunkIndex, let totalChunks = totalChunks {
            var buffer =
                pendingSprinkleFetches[requestId]
                ?? SprinkleFetchBuffer(sprinkleName: sprinkleName)
            buffer.totalChunks = totalChunks
            buffer.chunks[chunkIndex] = content
            pendingSprinkleFetches[requestId] = buffer
            if buffer.chunks.count >= totalChunks {
                assembled = (0..<totalChunks)
                    .compactMap { buffer.chunks[$0] }
                    .joined()
                pendingSprinkleFetches.removeValue(forKey: requestId)
            } else {
                assembled = nil
            }
        } else {
            assembled = content
            pendingSprinkleFetches.removeValue(forKey: requestId)
        }

        guard let final = assembled else { return }
        sprinkleContents[sprinkleName] = final
        inflightSprinkleNameToRequest.removeValue(forKey: sprinkleName)
        let waiters = sprinkleContentWaiters.removeValue(forKey: sprinkleName) ?? []
        for waiter in waiters {
            waiter.resume(returning: final)
        }
    }

    enum SprinkleFetchError: LocalizedError {
        case fetchFailed(String)

        var errorDescription: String? {
            switch self {
            case .fetchFailed(let reason):
                return "Failed to load sprinkle: \(reason)"
            }
        }
    }

    // MARK: - Private: Data Channel Message Handling

    /// Called from WebRTCBridge when the data channel opens.
    func dataChannelOpened() {
        logger.info("Data channel opened")
        connectionState = .connected
        let connectedAt = Date()
        connectedSince = connectedAt
        leaderProtocolVersion = nil
        leaderCapabilities = nil
        leaderMotd = nil
        modelCatalog = []
        modelSelectionState = nil
        let credentialsSaved = persistTrayCredentials(connectedAt: connectedAt)
        // A connection that landed is the signal recents keep — whichever way
        // it started (paste, deep link, iCloud row, stored credentials), and
        // after any supersede hop, so what syncs is the URL that works.
        recentJoinStore.record(joinUrl: activeJoinUrl, label: activeDisplayName ?? "")
        fileProviderDomainLifecycle.registerIfCredentialsAvailable(credentialsSaved)
        Task { await VoiceReply.shared.prewarm() }

        // Reuse the existing CDP bridge across reconnects so the user's
        // hosted tabs survive transient WebRTC drops. Only spin up a new
        // bridge if there isn't one (first connect, or after a user-
        // initiated `disconnect()` cleared it).
        let bridge = ensureCdpBridge()
        // Re-advertise existing targets so the (possibly new) leader knows
        // about every WKWebView we still own.
        bridge.advertiseTargets()
        refreshCDPTargets()
        startTargetsAdvertiseTimer()

        // Start keepalive.
        let rtc = webRTCManager
        keepalive = DataChannelKeepalive(
            sendPing: { [weak rtc] in
                guard let rtc else { return }
                if let data = try? JSONEncoder().encode(FollowerToLeaderMessage.ping) {
                    rtc.sendData(data)
                }
            },
            onDead: { [weak self] in
                Task { @MainActor [weak self] in
                    self?.handleDisconnect(reason: "Keepalive timeout")
                }
            },
            // A leader that stops answering but keeps its channel open is busy,
            // not gone. Without this gate the follower tore down a healthy
            // transport after ~30s and forced a full renegotiation.
            isTransportOpen: { [weak rtc] in rtc?.isConnected ?? false },
            onStalled: { [weak self] in
                Task { @MainActor [weak self] in self?.isLeaderStalled = true }
            },
            onRecovered: { [weak self] in
                Task { @MainActor [weak self] in self?.isLeaderStalled = false }
            }
        )
        Task { await keepalive?.start() }

        // Version handshake first — additive; legacy leaders drop it harmlessly.
        sendToLeader(
            .hello(
                protocolVersion: traySyncProtocolVersion,
                runtime: "slicc-ios",
                capabilities: followerCapabilities(),
                motd: trayFollowerMotd))
        openApprovalController.transportAvailable()
        startPushRegistration()

        // Request the preserved view so the fresh leader follower record
        // re-registers it before thinking changes can target that scoop.
        sendToLeader(snapshotRequestForConnection())
    }

    /// Called from WebRTCBridge when data arrives on the channel.
    ///
    /// Transport chunk frames are intercepted here, BEFORE the message union is
    /// decoded: reassembly completes into an ordinary message, so
    /// `routeLeaderMessage` and its switch never see framing (#1700).
    func handleDataChannelMessage(_ data: Data) {
        if let frame = try? JSONDecoder().decode(TrayChunkFrame.self, from: data),
            frame.type == TrayChunkFrame.typeTag
        {
            acceptChunkFrame(frame)
            return
        }
        routeLeaderMessage(data)
    }

    /// Decode one whole (already reassembled) leader message and act on it.
    private func routeLeaderMessage(_ data: Data) {
        let decoder = JSONDecoder()

        let msg: LeaderToFollowerMessage
        do {
            msg = try decoder.decode(LeaderToFollowerMessage.self, from: data)
        } catch {
            logger.error("\(SafeLeaderMessageLog.decodeFailureSummary(data))")
            return
        }

        switch msg {
        case .snapshot(let chatMessages, let scoopJid):
            logger.info("Snapshot received: \(chatMessages.count) messages, scoopJid=\(scoopJid)")
            ingestSnapshot(messages: chatMessages, scoopJid: scoopJid)
            // After ingest, so a settling transcript export reads the
            // fresh rows, not the ones this snapshot replaced (#1918).
            inboundSnapshot.settle(scoopJid: scoopJid)

        case .snapshotChunk(let chunkData, let chunkIndex, let totalChunks, _):
            logger.info("Snapshot chunk \(chunkIndex + 1)/\(totalChunks) received (\(chunkData.count) chars)")
            snapshotTotalChunks = totalChunks
            snapshotChunks[chunkIndex] = chunkData
            if snapshotChunks.count == totalChunks {
                let fullJson = (0..<totalChunks).compactMap { snapshotChunks[$0] }.joined()
                snapshotChunks.removeAll()
                logger.info("Reassembling chunked snapshot (\(fullJson.count) chars total)")
                if let jsonData = fullJson.data(using: .utf8) {
                    do {
                        let payload = try JSONDecoder().decode(SnapshotPayload.self, from: jsonData)
                        logger.info("Chunked snapshot decoded: \(payload.messages.count) messages, scoopJid=\(payload.scoopJid)")
                        ingestSnapshot(messages: payload.messages, scoopJid: payload.scoopJid)
                    } catch {
                        logger.error(
                            "Failed to decode reassembled snapshot (\(jsonData.count) bytes)")
                    }
                }
            }

        case .agentEvent(let event, let scoopJid):
            logger.debug("Agent event received: scoopJid=\(scoopJid)")
            handleAgentEvent(event, scoopJid: scoopJid)

        case .userMessageEcho(let text, let messageId, let scoopJid, let attachments):
            logger.debug("User message echo: id=\(messageId)")
            var buffer = messagesByScoop[scoopJid] ?? []
            if !buffer.contains(where: { $0.id == messageId }) {
                let msg = ChatMessage(
                    id: messageId,
                    role: .user,
                    content: text,
                    timestamp: Date().timeIntervalSince1970 * 1000,
                    attachments: attachments
                )
                buffer.append(msg)
                messagesByScoop[scoopJid] = buffer
                if scoopJid == selectedScoopJid {
                    messages = buffer
                }
            }

        case .status(let scoopStatus, let scoopJid):
            guard scoopJid == nil || scoopJid == selectedScoopJid else {
                logger.debug("Ignoring status update for non-selected scoop")
                break
            }
            logger.debug("Status update: \(scoopStatus)")
            let wasStreaming = isStreaming
            // The leader emits processing/ready; streaming/running remain accepted busy aliases.
            isStreaming = ["processing", "streaming", "running"].contains(scoopStatus)
            if wasStreaming && !isStreaming {
                streamingMessageId = nil
            }

        case .error(let error):
            logger.error("Leader error: \(error)")
            leaderError = error

        case .scoopsList(let scoops, let activeScoopJid):
            logger.info("Scoops list received: \(scoops.count) scoops, active=\(activeScoopJid)")
            self.scoops = scoops
            self.leaderActiveScoopJid = activeScoopJid
            // Select initially, or fall back when a preserved scoop disappeared.
            let preservedScoopExists =
                selectedScoopJid.map { selected in
                    scoops.contains(where: { $0.jid == selected })
                } ?? false
            if selectedScoopJid == nil || !preservedScoopExists {
                let hadMissingSelection = selectedScoopJid != nil
                let cone = scoops.first(where: { $0.isCone })
                let initial = hadMissingSelection ? activeScoopJid : (cone?.jid ?? activeScoopJid)
                if !initial.isEmpty {
                    selectedScoopJid = initial
                    // Re-register a missing preserved selection even when its
                    // active-scoop messages are already cached locally.
                    if hadMissingSelection || messagesByScoop[initial] == nil {
                        sendToLeader(.scoopsSelect(scoopJid: initial))
                    } else {
                        messages = messagesByScoop[initial] ?? []
                    }
                    refreshModels()
                }
            }

        case .modelsList(let models):
            guard supportsModelControls else {
                logger.warning("Ignoring models.list before a v5+ leader hello")
                break
            }
            modelCatalog = models

        case .modelState(let state):
            guard supportsModelControls else {
                logger.warning("Ignoring model.state before a v5+ leader hello")
                break
            }
            modelSelectionState = state

        case .sprinklesList(let sprinkles):
            logger.info("Sprinkles list received: \(sprinkles.count) sprinkles")
            self.sprinkles = sprinkles

        case .sprinkleContent(let requestId, let sprinkleName, let content, let chunkIndex, let totalChunks, let error):
            handleSprinkleContent(
                requestId: requestId,
                sprinkleName: sprinkleName,
                content: content,
                chunkIndex: chunkIndex,
                totalChunks: totalChunks,
                error: error
            )

        case .sprinkleUpdate(let sprinkleName, let data):
            logger.debug("Sprinkle update for \(sprinkleName)")
            if let data = data {
                sprinkleUpdates[sprinkleName] = data
            }

        case .sprinkleReloaded(let sprinkleName):
            logger.info("Sprinkle reloaded on leader: \(sprinkleName)")
            sprinkleContents.removeValue(forKey: sprinkleName)
            sprinkleReloadGeneration[sprinkleName, default: 0] += 1

        case .cdpRequest(let requestId, let localTargetId, let method, let params, let sessionId):
            logger.debug("CDP request \(method) target=\(localTargetId)")
            cdpBridge?.handleRequest(
                requestId: requestId,
                localTargetId: localTargetId,
                method: method,
                params: params,
                sessionId: sessionId
            )

        case .tabOpen(let requestId, let url):
            logger.info(
                "\(SafeLeaderMessageLog.urlEventSummary("Leader requested new tab", url: url))")
            // Surface it: a leader opens a tab here so a human can act on it
            // (an auth hand-off above all), which only works if the tab is
            // actually in front of them.
            leaderOpenedTabId = cdpBridge?.handleTabOpen(requestId: requestId, url: url)

        case .previewOpen(let requestId, let url):
            // Worker-hosted preview URL pushed by the leader after `serve`.
            // Same delivery path as tab.open: hand to CDPBridge which opens
            // the URL in a WKWebView CDP target. The preview-vs-tab
            // distinction is informational on iOS (Phase 1) — the request
            // id flows back via the standard tab.opened ack.
            logger.info(
                "\(SafeLeaderMessageLog.urlEventSummary("Leader requested preview tab", url: url))")
            cdpBridge?.handleTabOpen(requestId: requestId, url: url)

        case .targetsRegistry(let targets):
            // Tabs the tray federates elsewhere (leader + other followers);
            // the browser surface renders them as preview cards (#1865).
            // Our own advertised targets and the leader's own SLICC page are
            // excluded — see `BrowserTargets`.
            // `activeJoinUrl`, never `joinUrl`: an iCloud session deliberately
            // keeps its URL out of the published field (it carries the session
            // secret), so matching on `joinUrl` left a launcher-published
            // leader at 127.0.0.1 unrecognised and put its own SLICC page back
            // in the cards. Falling back to `joinUrl` would be worse than
            // nothing — a stale typed URL is not the one we dialled.
            remoteTargets = BrowserTargets.visible(
                targets, ownRuntimeId: controllerId, joinUrl: activeJoinUrl)

        case .cdpResponse(
            let requestId, let result, let error, let chunkData, let chunkIndex,
            let totalChunks):
            cdpPreviews.handleResponse(
                requestId: requestId, result: result, error: error,
                chunkData: chunkData, chunkIndex: chunkIndex, totalChunks: totalChunks)

        case .ping:
            sendToLeader(.pong)
            Task { await keepalive?.receivedPing() }

        case .pong:
            Task { await keepalive?.receivedPong() }

        case .cherrySliccEvent(let targetId, let name, _):
            // Cherry host-page events are not hosted on iOS (the follower has no
            // cherry page surface). Documented no-op: log and ignore. Present so the
            // switch stays exhaustive and a future cherry-on-iOS path has a seam.
            logger.debug("Ignoring cherry.slicc_event for target=\(targetId) name=\(name) (cherry pages not hosted on iOS)")

        case .fsRequest(let requestId, let request):
            // iOS federates no filesystem. Answer rather than drop: the
            // leader's `fs-router.ts` sets no timeout, so silence would leave
            // its promise pending for the life of the session.
            _ = sendToLeader(
                .fsResponse(requestId: requestId, response: FsClient.refusal(for: request)))

        case .fsResponse(let requestId, let response):
            fsClient.handleResponse(requestId: requestId, response: response)

        case .execRequest, .execChunk, .execResponse, .execSignal:
            handleExecMessage(msg)

        case .themeApply(let themeJson):
            applyLeaderTheme(themeJson)

        case .sudoApproveRequest, .sudoApproveCancel:
            handleSudoLeaderMessage(msg)

        case .hello(let protocolVersion, let runtime, let capabilities, let motd):
            handleLeaderHello(
                protocolVersion: protocolVersion, runtime: runtime, capabilities: capabilities,
                motd: motd)

        case .unknown(let type):
            // Protocol drift safety net — mirror of the TS dispatchers' warn.
            logger.warning("Unknown leader message type — skewed leader? type=\(type)")
        }
    }

    /// Record the leader's `hello` version handshake. Warn when the leader is
    /// newer than this build — the skew otherwise surfaces only as silently
    /// missing features.
    private func handleLeaderHello(
        protocolVersion: Int, runtime: String?, capabilities: TraySyncCapabilities?, motd: String?
    ) {
        leaderCapabilities = capabilities
        leaderMotd = motd
        leaderProtocolVersion = protocolVersion
        if protocolVersion >= 5 {
            refreshModels()
        } else {
            modelCatalog = []
            modelSelectionState = nil
        }
        if protocolVersion > traySyncProtocolVersion {
            logger.warning("Leader speaks a newer tray sync protocol (v\(protocolVersion) vs v\(traySyncProtocolVersion)) — update this app")
        } else {
            logger.info("Leader hello: protocol v\(protocolVersion) runtime=\(runtime ?? "?") exec=\(capabilities?.exec == true)")
        }
    }

    /// One-shot waiter for `slicc://prompt` automation — its own object so
    /// the settle logic stays out of this (size-capped) type body.
    let inboundPrompt = InboundPromptWaiter()
    /// Fresh-snapshot waiter for the transcript intent (#1918).
    let inboundSnapshot = InboundSnapshotWaiter()

    /// Speak a finished assistant reply when the turn it answers was dictated.
    ///
    /// Hooked to BOTH completion events because leaders disagree about which
    /// they send — a plain text turn from the browser leader arrives as
    /// `content_done` with no `turn_end` at all, which is why the first cut
    /// of this never made a sound. Consuming the mark is what makes the
    /// double hook safe: whichever event lands first is the only one that
    /// speaks. The consume happens even for a background scoop so marks and
    /// turns stay balanced; only a visible reply is read aloud.
    private func speakIfDictated(
        _ message: ChatMessage, scoopJid: String, isVisible: Bool
    ) {
        guard
            VoiceReply.shared.consumeSubmission(scoopJid: scoopJid, messageId: message.id),
            isVisible
        else { return }
        logger.notice("speaking the reply to a dictated turn")
        VoiceReply.shared.speakReply(markdown: message.content)
    }

    // MARK: - CDP advertise timer

    private func startTargetsAdvertiseTimer() {
        targetsAdvertiseTimer?.invalidate()
        targetsAdvertiseTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) {
            [weak self] _ in
            Task { @MainActor in
                self?.cdpBridge?.advertiseTargets()
            }
        }
    }

    private func stopTargetsAdvertiseTimer() {
        targetsAdvertiseTimer?.invalidate()
        targetsAdvertiseTimer = nil
    }

    /// Refresh the published `cdpTargets` from the bridge.
    private func refreshCDPTargets() {
        cdpTargets = cdpBridge?.currentTargets() ?? []
        // The tab on screen can be closed out from under the user (leader
        // Target.closeTarget, disconnect reset) — fall back to the overview
        // rather than presenting a dead id full screen.
        if let viewing = browserViewingTabId, !cdpTargets.contains(where: { $0.id == viewing }) {
            browserViewingTabId = nil
        }
    }

    /// Accessor for the live WKWebView backing a CDP target. Returns nil if
    /// the target is gone or the bridge isn't running.
    func cdpWebView(for targetId: String) -> WKWebView? {
        cdpBridge?.webView(for: targetId)
    }

    /// The bridge, created on first use. A user-opened tab may precede the
    /// first data-channel open (the browser surface renders in every
    /// connection state), and `sendToLeader` already drops messages while
    /// the channel is closed — `dataChannelOpened` re-advertises whatever
    /// targets exist once the leader can hear about them.
    private func ensureCdpBridge() -> CDPBridge {
        if let existing = cdpBridge { return existing }
        let bridge = CDPBridge(runtimeId: controllerId) { [weak self] msg in
            self?.sendToLeader(msg)
        }
        bridge.onTargetsChanged = { [weak self] in
            Task { @MainActor in self?.refreshCDPTargets() }
        }
        bridge.onHandoffDetected = { [weak self] pageURL, match, title in
            Task { @MainActor in
                self?.forwardNavigateLick(pageURL: pageURL, match: match, title: title)
            }
        }
        cdpBridge = bridge
        return bridge
    }

    /// Manually open a new tab (the browser surface's `+`). Returns the new
    /// target id so the UI can select the page and focus its address field.
    @discardableResult
    func cdpOpenTab(url: String = "about:blank") -> String {
        ensureCdpBridge().openTab(url: url)
    }

    /// Navigate a local tab from the address bar.
    func cdpNavigate(_ targetId: String, to url: String) {
        cdpBridge?.navigate(targetId: targetId, to: url)
    }

    /// Manually close a tab from the carousel.
    func cdpCloseTab(_ targetId: String) {
        cdpBridge?.handleRequest(
            requestId: "ui-close-\(UUID().uuidString)",
            localTargetId: targetId,
            method: "Target.closeTarget",
            params: AnyCodable(["targetId": targetId]),
            sessionId: nil
        )
    }

    /// Reload a tab.
    func cdpBridgeReload(_ targetId: String) {
        cdpBridge?.handleRequest(
            requestId: "ui-reload-\(UUID().uuidString)",
            localTargetId: targetId,
            method: "Page.reload",
            params: nil,
            sessionId: nil
        )
    }

    /// Apply a snapshot payload for `scoopJid` to the per-scoop buffer, and
    /// refresh `messages` if it matches the currently-viewed scoop.
    private func ingestSnapshot(messages chatMessages: [ChatMessage], scoopJid: String) {
        // The reply to a `new_session` request is the leader's CLEARED
        // snapshot. An unrelated snapshot (a scoop switch calls
        // `request_snapshot`) must not settle the guard — the leader
        // single-flights and would silently drop a second request the
        // re-enabled button could send. Only an empty snapshot counts; the
        // 120s backstop covers a leader whose reset broadcast is nonempty.
        if newSessionInFlight && chatMessages.isEmpty {
            newSessionInFlight = false
            newSessionTimeout?.cancel()
            // A new session in place keeps the connection but starts a new
            // conversation, so it re-arms the one-time priming note and drops
            // marks whose replies belong to the transcript just cleared.
            VoiceReply.shared.reset()
            DictationPriming.reset()
        }
        pruneToolProgress(replacing: messagesByScoop[scoopJid] ?? [], with: chatMessages)
        messagesByScoop[scoopJid] = chatMessages
        // A snapshot is the leader re-describing the world. Any approval
        // placeholder we are still holding predates it and can no longer be
        // confirmed, so it would otherwise hang around forever — the leader
        // only ever clears one via the matching `tool_ui_done`.
        toolUICards.removeAll()
        if selectedScoopJid == nil { selectedScoopJid = scoopJid }
        if scoopJid == selectedScoopJid {
            messages = chatMessages
            isStreaming = chatMessages.last?.isStreaming == true
            streamingMessageId = isStreaming ? chatMessages.last?.id : nil
        }
    }

    /// Process an AgentEvent from the leader, routing into the right scoop buffer.
    private func handleAgentEvent(_ event: AgentEvent, scoopJid: String) {
        var buffer = messagesByScoop[scoopJid] ?? []
        let isVisible = (scoopJid == selectedScoopJid)

        switch event {
        case .messageStart(let messageId):
            logger.info("Agent event: message_start id=\(messageId) scoop=\(scoopJid)")
            // The first message this scoop opens after a dictated submission
            // is that submission's answer — bind before any reply completes.
            VoiceReply.shared.bindReply(scoopJid: scoopJid, messageId: messageId)
            let newMsg = ChatMessage(
                id: messageId,
                role: .assistant,
                content: "",
                timestamp: Date().timeIntervalSince1970 * 1000,
                isStreaming: true
            )
            buffer.append(newMsg)
            messagesByScoop[scoopJid] = buffer
            if isVisible {
                cancelPendingMessagesFlush()
                messages = buffer
                isStreaming = true
                streamingMessageId = messageId
            }

        case .contentDelta(let messageId, let text):
            if let idx = buffer.firstIndex(where: { $0.id == messageId }) {
                buffer[idx].content += text
                messagesByScoop[scoopJid] = buffer
                if isVisible {
                    scheduleMessagesFlush(for: scoopJid)
                }
            }

        case .contentDone(let messageId, let model, let usage):
            logger.debug("Agent event: content_done id=\(messageId)")
            if let idx = buffer.firstIndex(where: { $0.id == messageId }) {
                buffer[idx].isStreaming = false
                // Match WcChatController: content_done finalizes only this message.
                // Turn-level busy state falls on turn_end or status: ready so tools
                // that follow remain stoppable and steerable.
                // Retained for cost attribution, as the webapp does. Neither
                // surface renders these in the thread.
                if let model { buffer[idx].model = model }
                if let usage { buffer[idx].usage = usage }
                messagesByScoop[scoopJid] = buffer
                if isVisible {
                    cancelPendingMessagesFlush()
                    messages = buffer
                }
                speakIfDictated(buffer[idx], scoopJid: scoopJid, isVisible: isVisible)
                inboundPrompt.settle(with: buffer[idx].content, scoopJid: scoopJid)
                notifyTurnEndIfBackgrounded(scoopJid: scoopJid)
            }

        case .toolUseStart(let messageId, let toolName, let toolInput, let toolCallId):
            logger.info("Agent event: tool_use_start id=\(messageId) tool=\(toolName)")
            if isVisible { runningToolCalls += 1 }
            applyToolUseStart(
                messageId: messageId, toolName: toolName, toolInput: toolInput,
                toolCallId: toolCallId, buffer: &buffer, scoopJid: scoopJid, isVisible: isVisible)

        case .toolResult(let messageId, let toolName, let result, let isError, let toolCallId):
            if isVisible {
                runningToolCalls = max(0, runningToolCalls - 1)
                // The failure flag is already mirrored on the wire, so the
                // glower needs no protocol change.
                if isError == true { avatarExpression.glower() }
            }
            applyToolResult(
                messageId: messageId, toolName: toolName, result: result, isError: isError,
                toolCallId: toolCallId, buffer: &buffer, scoopJid: scoopJid, isVisible: isVisible)

        // Progress ticks resolve against the transcript (to find the row) but
        // mutate only `toolProgress`, so they never republish `messages` — at
        // ~4/s per running unit that would be a redraw storm.
        case .toolProgress(let messageId, let toolName, let progress, let toolCallId):
            applyToolProgress(
                messageId: messageId, toolName: toolName, progress: progress,
                toolCallId: toolCallId, buffer: buffer)

        case .turnEnd(let messageId):
            logger.info("Agent event: turn_end id=\(messageId)")
            if let idx = buffer.firstIndex(where: { $0.id == messageId }) {
                buffer[idx].isStreaming = false
                clearToolProgress(for: buffer[idx])
                messagesByScoop[scoopJid] = buffer
                if isVisible {
                    cancelPendingMessagesFlush()
                    messages = buffer
                    isStreaming = false
                    streamingMessageId = nil
                }
                speakIfDictated(buffer[idx], scoopJid: scoopJid, isVisible: isVisible)
                inboundPrompt.settle(with: buffer[idx].content, scoopJid: scoopJid)
                notifyTurnEndIfBackgrounded(scoopJid: scoopJid)
            }

        case .error(let error):
            logger.error("Agent event: error — \(error)")
            if let idx = buffer.lastIndex(where: { $0.isStreaming == true }) {
                buffer[idx].isStreaming = false
                clearToolProgress(for: buffer[idx])
                messagesByScoop[scoopJid] = buffer
                if isVisible {
                    cancelPendingMessagesFlush()
                    messages = buffer
                }
            }
            if isVisible { leaderError = error }
            inboundPrompt.fail(scoopJid: scoopJid, error: error)
            settleTurn(messageId: nil, isVisible: isVisible)

        // Events that mutate no transcript state. Kept as a single arm so the
        // switch stays exhaustive — a new protocol case is then a compile error
        // rather than a silent drop — without charging this dispatcher's
        // complexity budget once per case.
        case .toolUI, .toolUIDone, .screenshot, .terminalOutput, .unknown:
            handleNonTranscriptAgentEvent(event)
        }
    }

    /// Settle only the visible turn that the terminal event belongs to.
    private func settleTurn(messageId: String?, isVisible: Bool) {
        guard isVisible, let activeMessageId = streamingMessageId else { return }
        guard messageId == nil || messageId == activeMessageId else { return }
        isStreaming = false
        streamingMessageId = nil
    }

    /// Agent events that never touch `messages`.
    ///
    /// `tool_ui` / `tool_ui_done` drive the read-only approval placeholder,
    /// which lives beside the transcript rather than in it. `screenshot` and
    /// `terminal_output` are deliberate no-ops on every follower — the webapp
    /// chat thread names both explicitly for the same reason.
    private func handleNonTranscriptAgentEvent(_ event: AgentEvent) {
        switch event {
        case .toolUI(let messageId, let toolName, let requestId, let html):
            logger.debug(
                "Agent event: tool_ui id=\(messageId) tool=\(toolName) request=\(requestId)"
            )
            let card = ToolUIPlaceholder(requestId: requestId, html: html)
            // A re-broadcast of the same request must not stack a duplicate.
            if let existing = toolUICards.firstIndex(where: { $0.id == requestId }) {
                toolUICards[existing] = card
            } else {
                toolUICards.append(card)
            }
        case .toolUIDone(let messageId, let requestId):
            logger.debug("Agent event: tool_ui_done id=\(messageId) request=\(requestId)")
            // The leader removes the card outright — there is no terminal
            // "approved"/"denied" state to show.
            toolUICards.removeAll { $0.id == requestId }
        case .screenshot, .terminalOutput:
            break
        default:
            logger.debug("Agent event: unknown type")
        }
    }

    // MARK: - Private: Send to Leader

    /// Send a message to the leader, framing it when it exceeds the SCTP
    /// per-message limit.
    ///
    /// iOS originates only small messages today, but an unbounded one (a large
    /// pasted user message) would otherwise be dropped by the transport with no
    /// signal at all.
    ///
    /// Every write is checked. Continuing past a failed frame would leave the
    /// leader holding an incomplete reassembly until eviction and the user with
    /// no indication their message was lost — the silent-drop behaviour this
    /// whole change exists to remove (#1700).
    @discardableResult
    func sendToLeader(_ msg: FollowerToLeaderMessage) -> Bool {
        let data: Data
        do {
            data = try JSONEncoder().encode(msg)
        } catch {
            logger.error("Failed to encode message: \(error.localizedDescription)")
            return false
        }

        if data.count <= TrayChunkLimits.maxMessageBytes {
            guard webRTCManager?.sendData(data) == true else {
                logger.error("Send failed (\(data.count) bytes)")
                return false
            }
            return true
        }

        guard data.count <= TrayChunkLimits.maxTotalBytes,
            let text = String(bytes: data, encoding: .utf8)
        else {
            logger.error("Refusing to send oversize message (\(data.count) bytes)")
            return false
        }
        // Only chunked sends are gated: a congested channel must still carry
        // keepalive ping/pong, or a busy peer reads as a dead one.
        let queued = webRTCManager?.bufferedAmount ?? 0
        guard queued < UInt64(TrayChunkLimits.sendHighWaterBytes) else {
            logger.error("Refusing chunked send — channel congested (\(queued) bytes queued)")
            return false
        }
        let frames = TrayChunkFraming.frameChunks(text)
        for frame in frames {
            guard let encoded = try? JSONEncoder().encode(frame),
                webRTCManager?.sendData(encoded) == true
            else {
                logger.error("Chunked send failed at frame \(frame.chunkIndex + 1)/\(frames.count)")
                return false
            }
        }
        return true
    }

    // MARK: - Messages flush throttling

    /// Throttle interval for streaming `messages` republishes. ~33ms keeps the
    /// chat feeling live (≈30fps) without flooding SwiftUI's update graph on
    /// every byte of agent text.
    private static let messagesFlushIntervalNs: UInt64 = 33_000_000

    /// Schedule a coalesced flush of `messages` from the per-scoop buffer.
    /// Called from contentDelta to avoid setting `messages` on every byte.
    private func scheduleMessagesFlush(for scoopJid: String) {
        guard pendingMessagesFlush == nil else { return }
        pendingMessagesFlush = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: AppState.messagesFlushIntervalNs)
            guard let self else { return }
            self.pendingMessagesFlush = nil
            // Only publish if the user is still viewing the same scoop and the
            // buffer still exists — drop stale flushes after a scoop switch.
            if self.selectedScoopJid == scoopJid,
                let buffer = self.messagesByScoop[scoopJid]
            {
                self.messages = buffer
            }
        }
    }

    /// Cancel any in-flight throttled flush — used when a decisive event
    /// (messageStart/contentDone/toolResult/turnEnd) writes a fresh `messages`
    /// snapshot synchronously and we don't want a stale flush to overwrite it.
    /// Internal rather than private so the tool-call extension can flush too.
    func cancelPendingMessagesFlush() {
        pendingMessagesFlush?.cancel()
        pendingMessagesFlush = nil
    }

    // MARK: - Private: Disconnect Handling

    /// Called when WebRTC or keepalive detects a disconnect.
    func handleDisconnect(reason: String) {
        guard connectionState == .connected || connectionState == .reconnecting else { return }

        openApprovalController.disconnect()
        sudoApprovalController.transportLost()
        terminalClient.disconnect()

        // A stall that ends in a real disconnect must not leave the composer
        // wedged: the stall is over, the connection is what is broken now.
        //
        // Both writes land as ONE reading. Clearing the stall on its own reads
        // as a connected, answering leader for an instant, and the settler
        // would take that intermediate for a recovery — dropping the static
        // eyes and then holding the disconnect for a whole window, so an
        // outage that never ended would render as fine.
        let willRetry = autoReconnect
        updateConnection {
            isLeaderStalled = false
            connectionState = willRetry ? .reconnecting : .failed
        }

        guard willRetry else {
            lastError = reason
            return
        }

        streamingMessageId = nil
        reconnectTask?.cancel()
        reconnectTask = Task { @MainActor [weak self] in
            await self?.runReconnectLoop(initialReason: reason)
        }
    }

    /// Bounded exponential backoff, mirroring `startFollowerWithAutoReconnect`.
    ///
    /// A transient drop deliberately does not render as a permanent error: the
    /// state stays `.reconnecting` with a visible attempt count, and only an
    /// exhausted budget reaches the terminal `.gaveUp`.
    private func runReconnectLoop(initialReason: String) async {
        for attempt in 1...ReconnectBackoff.maxAttempts {
            reconnectAttempt = attempt
            connectionState = .reconnecting

            let delay = ReconnectBackoff.delay(forAttempt: attempt)
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            // A user-initiated disconnect (or a connect that already landed)
            // moves us out of `.reconnecting`; abandon the budget silently.
            guard connectionState == .reconnecting else { return }

            connect(to: activeJoinUrl, displayName: activeDisplayName)

            // `connect(to:)` drives its own async signaling; wait for it to settle
            // before deciding whether this attempt earned another.
            await connectTask?.value
            if Task.isCancelled { return }
            if connectionState == .connected {
                reconnectAttempt = 0
                lastError = nil
                return
            }
        }

        guard !Task.isCancelled else { return }
        connectionState = .gaveUp
        lastError =
            "Couldn't reach the leader after \(ReconnectBackoff.maxAttempts) attempts "
            + "(\(initialReason)). Reload to retry."
        reconnectAttempt = 0
    }

}

// MARK: - Teardown and history

extension AppState {
    /// Tear down transport state (signaling, WebRTC, keepalive) ahead of a
    /// reconnect. Deliberately does NOT touch the CDP bridge — open tabs
    /// must survive transient WebRTC drops. Use `resetCDPState()` from
    /// `disconnect()` to fully drop tabs on a user-initiated disconnect.
    fileprivate func tearDown() {
        openApprovalController.disconnect()
        sudoApprovalController.transportLost()
        terminalClient.disconnect()
        connectTask?.cancel()
        connectTask = nil
        Task { await keepalive?.stop() }
        keepalive = nil
        webRTCManager?.close()
        webRTCManager = nil
        webRTCDelegate = nil
        signalingClient = nil
        snapshotChunks.removeAll()
        chunkReassembler.removeAll()
        cancelPendingMessagesFlush()
        // Pause the targets re-advertise timer; we'll restart it once the
        // next data channel comes up. The CDP bridge itself stays alive.
        stopTargetsAdvertiseTimer()
    }

}

extension AppState {
    /// Clear all stored data (history, credentials, etc.)
    func clearStoredData() {
        // Only this device's recents: nothing can write another device's
        // iCloud key, so a row it recorded can sync back.
        recentJoinStore.clearLocalHistory()
        credentialStore.clear()
        fileProviderDomainLifecycle.removeDomain()
        Self.purgeLegacyJoinURLDefaults()
        openApprovalController.revokeAllGrants()
    }

    fileprivate static func purgeLegacyJoinURLDefaults() {
        // Join URLs carry session secrets and must not remain in defaults.
        UserDefaults.standard.removeObject(forKey: "joinUrlHistory")
        UserDefaults.standard.removeObject(forKey: "joinUrl")
    }

    fileprivate func persistTrayCredentials(connectedAt: Date) -> Bool {
        guard let trayID = trayId, let joinURL = URL(string: activeJoinUrl) else { return false }
        return credentialStore.save(
            joinURL: joinURL,
            trayID: trayID,
            displayName: activeDisplayName,
            lastConnectedAt: connectedAt)
    }

    fileprivate func clearTrayCredentials() {
        credentialStore.clear()
        activeJoinUrl = ""
        activeDisplayName = nil
    }
}

// MARK: - Scoop / Model / Thinking Selection

extension AppState {
    /// Snapshot request sent on every fresh data channel, preserving the viewed scoop.
    /// Re-request the selected scoop's snapshot (transcript export wants
    /// fresh rows, not the in-memory mirror; #1918).
    func requestFreshSnapshot() {
        _ = sendToLeader(snapshotRequestForConnection())
    }

    func snapshotRequestForConnection() -> FollowerToLeaderMessage {
        .requestSnapshot(scoopJid: selectedScoopJid)
    }

    /// Select a specific scoop to view. Independent of the leader's selection.
    func selectScoop(jid: String) {
        guard jid != selectedScoopJid else { return }
        guard scoops.contains(where: { $0.jid == jid }) else { return }
        selectedScoopJid = jid
        // Show whatever we already have buffered, then request a fresh snapshot.
        let cached = messagesByScoop[jid] ?? []
        messages = cached
        isStreaming = cached.last?.isStreaming == true
        streamingMessageId = isStreaming ? cached.last?.id : nil
        // `scoops.select` changes only this follower's view on the leader. It
        // also updates the leader's per-follower selected scoop, which is the
        // authority used to validate a later thinking.set.
        sendToLeader(.scoopsSelect(scoopJid: jid))
        refreshModels()
    }

    /// The summary for the currently-viewed scoop, if any.
    var selectedScoop: ScoopSummary? {
        scoops.first(where: { $0.jid == selectedScoopJid })
    }

    var supportsModelControls: Bool {
        (leaderProtocolVersion ?? 0) >= 5
    }

    /// Whether the leader understands `tab.teleport.request` (protocol v6):
    /// a tray tab opened here carrying its cookies + web storage, rather than
    /// the bare-URL copy an older leader can offer.
    var supportsTabTeleport: Bool {
        (leaderProtocolVersion ?? 0) >= 6
    }

    /// Ask the leader to teleport a tray tab here. The reply arrives as
    /// `tab.opened`, which surfaces the new tab through `leaderOpenedTabId`.
    func requestTabTeleport(targetId: String) -> Bool {
        sendToLeader(
            .tabTeleportRequest(
                requestId: "tab-teleport-\(UUID().uuidString)", targetId: targetId))
    }

    var activeModel: TrayModelCatalogEntry? {
        guard let activeModelId = modelSelectionState?.activeModelId else { return nil }
        return modelCatalog.first(where: { $0.modelId == activeModelId })
    }

    var displayedThinkingLevel: String {
        guard modelSelectionState?.scoopJid == selectedScoopJid else { return "off" }
        if modelSelectionState?.effortOverride == "max" { return "max" }
        switch modelSelectionState?.thinkingLevel {
        case .minimal: return "low"
        case .off, nil: return "off"
        case .low: return "low"
        case .medium: return "medium"
        case .high: return "high"
        case .xhigh: return "xhigh"
        }
    }

    /// Refresh the credential-free catalog and current selection state. Legacy
    /// leaders never see this additive v5 request.
    func refreshModels() {
        guard supportsModelControls else { return }
        sendToLeader(.modelsRequest)
    }

    /// Ask the leader to change its global model selection. Only advertised
    /// catalog ids are accepted, preventing arbitrary provider/account data
    /// from reaching the wire.
    func selectModel(_ modelId: String) {
        guard supportsModelControls,
            modelCatalog.contains(where: { $0.modelId == modelId })
        else { return }
        sendToLeader(.modelSelect(modelId: modelId))
    }

    /// Map the Settings control's browser-compatible scale onto the wire. The
    /// UI-only `max` value is encoded as xhigh + effortOverride max.
    func setThinkingLevel(_ displayLevel: String) {
        guard supportsModelControls, activeModel?.reasoning == true,
            let scoopJid = selectedScoopJid,
            let wireValue = Self.thinkingWireValue(for: displayLevel)
        else { return }
        sendToLeader(
            .thinkingSet(
                scoopJid: scoopJid, thinkingLevel: wireValue.level,
                effortOverride: wireValue.effortOverride))
    }

    static func thinkingWireValue(
        for displayLevel: String
    ) -> (level: TrayThinkingLevel, effortOverride: String?)? {
        if displayLevel == "max" { return (.xhigh, "max") }
        guard let level = TrayThinkingLevel(rawValue: displayLevel) else { return nil }
        return (level, nil)
    }
}

// MARK: - Connect entry points

/// The three ways a connection starts. They live in an extension so they stay
/// outside the `AppState` body, which sits against the SwiftLint
/// `type_body_length` ceiling; the dialing machinery itself stays in the class.
extension AppState {
    /// Attempt to connect to the tray using the current joinUrl.
    func connect() {
        connect(to: joinUrl, displayName: nil)
    }

    /// Join an iCloud-discovered session. The URL stays out of the Join URL
    /// field; recents remember it only once the connection lands, and render
    /// it as label plus host — never as the secret-bearing URL.
    func connectToDiscoveredSession(joinUrl url: String, displayName: String? = nil) {
        connect(to: url, displayName: displayName)
    }

    /// A device that has connected before lands in the conversation, not in
    /// Settings: try the Keychain-stored last-good session on launch and let
    /// Settings appear only when there is nothing to try. A dead session
    /// surfaces through the normal retry path (`.gaveUp` presents Settings).
    /// Gated on the same Auto-reconnect toggle that governs drop recovery.
    @discardableResult
    func attemptStoredConnection() -> Bool {
        guard autoReconnect,
            connectionState == .disconnected,
            let credentials = credentialStore.load()
        else { return false }
        connect(
            to: credentials.joinURL.absoluteString,
            displayName: credentials.displayName)
        return true
    }
}

// MARK: - Transport chunk reassembly

extension AppState {
    /// Buffer one inbound frame, routing the reconstructed message once the
    /// last frame lands (#1700). The framing and eviction rules themselves live
    /// in `TrayChunkReassembler`, which is unit-tested without an app.
    func acceptChunkFrame(_ frame: TrayChunkFrame) {
        let outcome = chunkReassembler.accept(frame)
        switch outcome.rejection {
        case .malformed:
            logger.warning("Dropping malformed chunk frame")
        case .oversize:
            logger.error("Dropping oversize chunked message")
        case nil:
            break
        }
        guard let message = outcome.message else { return }
        routeLeaderMessage(message)
    }
}

// MARK: - WebRTCBridge

/// Non-@MainActor delegate that bridges WebRTC callbacks to AppState on the main actor.
/// WebRTCManager delegate methods are called from WebRTC's internal threads.
private class WebRTCBridge: NSObject, WebRTCManagerDelegate {
    private weak var appState: AppState?

    init(appState: AppState) {
        self.appState = appState
    }

    func webRTCManager(_ manager: WebRTCManager, didOpenDataChannel channel: RTCDataChannel) {
        Task { @MainActor [weak self] in
            self?.appState?.dataChannelOpened()
        }
    }

    func webRTCManager(_ manager: WebRTCManager, didReceiveMessage data: Data) {
        Task { @MainActor [weak self] in
            self?.appState?.handleDataChannelMessage(data)
        }
    }

    func webRTCManager(_ manager: WebRTCManager, didChangeConnectionState state: RTCIceConnectionState) {
        // Informational — disconnect is handled by the specific disconnect callback.
    }

    func webRTCManager(_ manager: WebRTCManager, didGenerateLocalCandidate candidate: RTCIceCandidate) {
        Task { @MainActor [weak self] in
            guard let self, let appState = self.appState else { return }
            // Forward local ICE candidates to the signaling server.
            guard let client = appState.signalingClient else { return }
            let trayCandidate = TrayIceCandidate(
                candidate: candidate.sdp,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: Int(candidate.sdpMLineIndex),
                usernameFragment: nil
            )
            // Fire-and-forget; best-effort delivery.
            Task {
                _ = try? await client.sendIceCandidate(
                    controllerId: appState.controllerId,
                    bootstrapId: appState.currentBootstrapId ?? "",
                    candidate: trayCandidate
                )
            }
        }
    }

    func webRTCManagerDidDisconnect(_ manager: WebRTCManager, reason: String) {
        Task { @MainActor [weak self] in
            self?.appState?.handleDisconnect(reason: reason)
        }
    }
}

// MARK: - AppStateError

enum AppStateError: LocalizedError {
    case attachFailed(String)

    var errorDescription: String? {
        switch self {
        case .attachFailed(let reason):
            return "Failed to attach to tray: \(reason)"
        }
    }
}

// MARK: - Signaling Loop

/// The attach → bootstrap → data-channel flow. An extension rather than a
/// member of the class body only to keep `AppState` under the
/// `type_body_length` ceiling; `private` still spans the whole file.
extension AppState {
    /// Runs the full attach → poll → offer → answer → ICE → connected flow.
    private func runSignalingLoop(client: TraySignalingClient, rtc: WebRTCManager) async {
        do {
            // Step 1: Attach — may need to retry if leader not yet connected,
            // and may land on a different tray than we dialed (a superseded
            // join URL redirects), so the rest of the flow uses the client the
            // attach settled on rather than the one we were handed.
            let (plan, client) = try await attachWithRetry(client: client)

            self.trayId = plan.trayId
            self.participantCount = plan.participantCount
            self.leaderConnected = plan.leader?.connected ?? false

            guard let bootstrap = plan.bootstrap,
                let iceServers = plan.iceServers
            else {
                self.connectionState = .failed
                self.lastError = "Attach succeeded but no bootstrap or ICE servers"
                return
            }

            // Step 2: Configure WebRTC with TURN servers.
            rtc.configure(iceServers: iceServers)

            // Step 3: Poll for offer and ICE candidates.
            let bootstrapId = bootstrap.bootstrapId
            self.currentBootstrapId = bootstrapId
            var cursor: Int? = bootstrap.cursor

            // Process any events already present in the attach response.
            // (The attach response doesn't include events; they come from poll.)

            var gotOffer = false
            let maxPolls = 60  // Safety limit
            for _ in 0..<maxPolls {
                if Task.isCancelled { return }

                let poll = try await client.pollBootstrap(
                    controllerId: controllerId,
                    bootstrapId: bootstrapId,
                    cursor: cursor
                )
                cursor = poll.bootstrap.cursor

                self.participantCount = poll.participantCount
                self.leaderConnected = poll.leader?.connected ?? false

                for event in poll.events {
                    switch event {
                    case .offer(_, _, let offer):
                        let answer = try await rtc.handleOffer(sdp: offer.sdp)
                        let answerDesc = TraySessionDescription(
                            type: .answer, sdp: answer.sdp)
                        _ = try await client.sendAnswer(
                            controllerId: controllerId,
                            bootstrapId: bootstrapId,
                            answer: answerDesc
                        )
                        gotOffer = true

                    case .iceCandidate(_, _, let cand):
                        try await rtc.addIceCandidate(
                            candidate: cand.candidate,
                            sdpMid: cand.sdpMid,
                            sdpMLineIndex: cand.sdpMLineIndex.map { Int32($0) }
                        )

                    case .failed(_, _, let failure):
                        self.connectionState = .failed
                        self.lastError = failure.message
                        return
                    }
                }

                // Check if we're connected now.
                if poll.bootstrap.state == .connected {
                    break
                }

                // If we have the offer + answer, wait for data channel open
                // (WebRTCManager delegate will call dataChannelOpened).
                if gotOffer && poll.events.isEmpty {
                    // Brief pause before next poll.
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }

                // If no events, the leader hasn't sent anything yet — pause.
                if poll.events.isEmpty && !gotOffer {
                    let delay = poll.bootstrap.retryAfterMs ?? 2000
                    try? await Task.sleep(
                        nanoseconds: UInt64(delay) * 1_000_000)
                }
            }

        } catch is CancellationError {
            return
        } catch {
            self.connectionState = .failed
            self.lastError = error.localizedDescription
        }
    }

    /// Attach to the tray, retrying when the leader isn't connected yet and
    /// following a superseded tray to its replacement.
    ///
    /// Returns the client the attach settled on: a redirect swaps it, and
    /// bootstrap polling has to speak to the tray that issued the bootstrap.
    private func attachWithRetry(
        client: TraySignalingClient
    ) async throws -> (plan: FollowerAttachPlan, client: TraySignalingClient) {
        let maxWaitAttempts = 30
        var client = client
        var waitAttempts = 0
        var redirectsFollowed = 0

        while waitAttempts < maxWaitAttempts {
            if Task.isCancelled { throw CancellationError() }

            let plan = try await client.attach(controllerId: controllerId)

            switch plan.action {
            case .signal:
                return (plan, client)
            case .wait:
                waitAttempts += 1
                let delay = plan.retryAfterMs ?? 2000
                try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            case .fail:
                let outcome = SupersedeRedirect.outcome(
                    for: plan, redirectsFollowed: redirectsFollowed)
                guard case .follow(let replacement) = outcome else {
                    throw AppStateError.attachFailed(
                        SupersedeRedirect.failureMessage(for: outcome)
                            ?? plan.error ?? plan.code)
                }
                // A redirect is a different tray, not another try at this one,
                // so it spends the supersede bound instead of the wait budget.
                // `SupersedeRedirect` caps the chase, so this cannot spin.
                redirectsFollowed += 1
                client = followSuperseded(to: replacement)
                try await Task.sleep(
                    nanoseconds: UInt64(SupersedeRedirect.delaySeconds * 1_000_000_000))
            }
        }
        throw AppStateError.attachFailed("Max attach retries exceeded")
    }

    /// Point this connection at a replacement tray. The controller id is
    /// regenerated because the previous one is a participant of the tray we are
    /// leaving, and `activeJoinUrl` moves so reconnects — and the Keychain
    /// credentials written once we land (`persistTrayCredentials`) — carry the
    /// live tray rather than resurrecting the superseded one.
    private func followSuperseded(to replacement: URL) -> TraySignalingClient {
        logger.info("Tray superseded; following redirect to the replacement tray")
        controllerId = UUID().uuidString
        activeJoinUrl = replacement.absoluteString
        let client = TraySignalingClient(joinUrl: replacement)
        signalingClient = client
        return client
    }
}
