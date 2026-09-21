import Foundation
import SliccTrayKit
import SliccTraySession
import SliccWidgetKit
import SwiftUI
import WebKit
import WebRTC
import os


enum ConnectionState: String {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed
    
    
    
    case gaveUp
}



enum ReconnectBackoff {
    static let baseDelay: TimeInterval = 1
    static let multiplier: Double = 2
    static let maxDelay: TimeInterval = 30
    static let maxAttempts = 10

    
    static func delay(forAttempt attempt: Int) -> TimeInterval {
        guard attempt > 1 else { return baseDelay }
        let grown = baseDelay * pow(multiplier, Double(attempt - 1))
        return min(grown, maxDelay)
    }
}





private struct SnapshotPayload: Codable {
    let messages: [ChatMessage]
    let scoopJid: String
}






@MainActor
class AppState: ObservableObject {

    

    private let logger = Logger(subsystem: "com.slicc.follower", category: "AppState")

    

    @Published var connectionState: ConnectionState = .disconnected {
        didSet { ingestConnectionHealth() }
    }
    @Published var joinUrl: String = ""
    @Published var trayId: String?
    @Published var messages: [ChatMessage] = []
    
    
    
    @Published var toolUICards: [ToolUIPlaceholder] = []
    @Published var openApprovals: [OpenApprovalRequest] = []
    @Published var openGrants: [OpenGrant] = []
    
    @Published var sudoApprovals: [SudoApprovalRequest] = []
    @Published var isStreaming: Bool = false {
        
        
        
        
        didSet {
            guard oldValue != isStreaming else { return }
            runningToolCalls = 0
            awaitingUserSince = isStreaming ? nil : Date()
        }
    }

    
    
    
    
    
    

    
    
    
    @Published private(set) var runningToolCalls: Int = 0
    
    
    @Published private(set) var awaitingUserSince: Date?
    
    
    let avatarExpression = AvatarExpressionEngine()

    
    
    @Published var scoops: [ScoopSummary] = []
    
    @Published var computers: [ComputerDescriptor] = []
    let computerRosterStorage = ComputerRosterStorage()
    
    @Published var selectedScoopJid: String?
    
    @Published var leaderActiveScoopJid: String?

    
    
    @Published private(set) var leaderProtocolVersion: Int?
    @Published private(set) var modelCatalog: [TrayModelCatalogEntry] = []
    @Published private(set) var modelSelectionState: TrayModelSelectionState?

    
    
    
    
    
    
    var composerTargetsLeaderActiveScoop: Bool {
        guard let selected = selectedScoopJid, let active = leaderActiveScoopJid else {
            return true
        }
        return selected == active
    }
    
    
    
    var messagesByScoop: [String: [ChatMessage]] = [:]
    
    var localSends = LocalSendLedger()
    var threadSync = ThreadSyncPlanner()
    
    
    
    
    
    
    
    
    @Published var toolProgress: [String: ToolProgressEvent] = [:]

    
    @Published var sprinkles: [SprinkleSummary] = []
    
    @Published var sprinkleContents: [String: String] = [:]
    
    private var pendingSprinkleFetches: [String: SprinkleFetchBuffer] = [:]
    
    private var inflightSprinkleNameToRequest: [String: String] = [:]
    
    private var sprinkleContentWaiters: [String: [CheckedContinuation<String, Error>]] = [:]
    
    
    private(set) lazy var fsClient = FsClient { [weak self] message in
        self?.sendToLeader(message) ?? false
    }
    
    
    
    private(set) lazy var fileMentionResolver = FileMentionResolver { [weak self] path in
        guard let self else { return false }
        return await self.transcriptFileExists(path)
    }
    
    private(set) lazy var terminalClient = TerminalClient { [weak self] in
        self?.sendToLeader($0) ?? false
    }
    private(set) lazy var openApprovalController = makeOpenApprovalController()
    private(set) lazy var sudoApprovalController = makeSudoApprovalController()
    
    private(set) lazy var cdpPreviews = CdpPreviewClient { [weak self] message in
        self?.sendToLeader(message) ?? false
    }
    
    
    @Published private(set) var leaderCapabilities: TraySyncCapabilities?
    private(set) var leaderMotd: String?
    
    
    
    private var seenHandoffFingerprints: Set<String> = []
    
    @Published var sprinkleUpdates: [String: AnyCodable] = [:]
    
    @Published var sprinkleReloadGeneration: [String: Int] = [:]

    
    @Published var leaderConnected: Bool = false
    @Published var participantCount: Int = 0
    @Published var connectedSince: Date?
    @Published var autoReconnect: Bool = true

    
    
    
    @Published var lastError: String?
    
    
    @Published var leaderTheme: SliccTheme?

    
    
    
    @Published var leaderError: String?

    
    
    
    
    @Published var isLeaderStalled: Bool = false {
        didSet { ingestConnectionHealth() }
    }

    
    @Published var reconnectAttempt: Int = 0 {
        didSet { ingestConnectionHealth() }
    }

    

    
    
    
    
    
    
    
    
    
    
    @Published private(set) var settledConnection = ConnectionHealth(state: .disconnected)

    
    
    
    
    
    
    
    let connectionSettler = ConnectionSettler(
        initial: ConnectionHealth(state: .disconnected))

    
    
    var connectionIngestSuspended = false

    
    private struct SprinkleFetchBuffer {
        let sprinkleName: String
        var chunks: [Int: String] = [:]
        var totalChunks: Int = 1
    }

    

    
    
    
    
    
    
    
    let widgetPublisher: WidgetSnapshotPublisher
    
    
    var widgetRecency = UnitRecencyLedger()
    let sessionStore: TraySessionSyncStore
    
    
    
    let recentJoinStore: RecentJoinStore
    private let credentialStore: TrayCredentialStore
    private let fileProviderDomainLifecycle: FileProviderDomainLifecycle
    let openGrantStore: OpenGrantStore

    
    
    
    
    
    init(
        credentialStore: TrayCredentialStore = TrayCredentialStore(),
        fileProviderDomainLifecycle: FileProviderDomainLifecycle = FileProviderDomainLifecycle(),
        openGrantStore: OpenGrantStore = OpenGrantStore(),
        fixtureDefaults: UserDefaults = .standard
    ) {
        widgetPublisher = WidgetSnapshotPublisher(store: WidgetHost.follower.store)
        sessionStore = AppState.makeSessionStore(fixtureDefaults: fixtureDefaults)
        recentJoinStore = AppState.makeRecentJoinStore(fixtureDefaults: fixtureDefaults)
        self.credentialStore = credentialStore
        self.fileProviderDomainLifecycle = fileProviderDomainLifecycle
        self.openGrantStore = openGrantStore
        openGrants = openGrantStore.grants
        connectionSettler.onChange = { [weak self] health in
            self?.settledConnection = health
            
            
            
            
            
            
            
            
            self?.publishWidgetSnapshot()
        }
        Self.purgeLegacyJoinURLDefaults()
        fileProviderDomainLifecycle.registerIfCredentialsAvailable(credentialStore.load() != nil)
        #if DEBUG
            if let fixtureScoops = UITestHooks.scoopStatusFixture() {
                scoops = fixtureScoops
                selectedScoopJid = fixtureScoops.first?.jid
                leaderActiveScoopJid = fixtureScoops.first?.jid
            } else {
                _ = UITestHooks.applyUnitRoleFixture(into: self)
            }
            configureOpenApprovalFixture()
            configureSudoApprovalFixture()
        #endif
        wireNotificationActions()
        
        
        
        
        publishWidgetSnapshot()
    }

    

    
    fileprivate var signalingClient: TraySignalingClient?
    private var webRTCManager: WebRTCManager?
    private var webRTCDelegate: WebRTCBridge?
    private var keepalive: DataChannelKeepalive?
    private var connectTask: Task<Void, Never>?
    
    
    
    private var reconnectTask: Task<Void, Never>?
    fileprivate var controllerId: String = UUID().uuidString
    fileprivate var currentBootstrapId: String?

    
    private var snapshotChunks: [Int: String] = [:]
    private var snapshotTotalChunks: Int = 0
    
    private var chunkReassembler = TrayChunkReassembler()

    
    
    var streamingMessageId: String?

    
    
    
    
    private var pendingMessagesFlush: Task<Void, Never>?

    

    
    private var cdpBridge: CDPBridge?
    
    private var targetsAdvertiseTimer: Timer?
    
    @Published var cdpTargets: [CDPTargetSummary] = []
    
    
    @Published var remoteTargets: [TrayTargetEntry] = []
    
    
    
    @Published var browserViewingTabId: String?
    
    
    @Published var viewingComputerId: String?
    
    
    
    
    @Published var leaderOpenedTabId: String?

    

    
    
    
    
    private var activeJoinUrl: String = ""
    var activeDisplayName: String?

    

    
    
    
    
    @Published var newSessionInFlight = false
    private var newSessionTimeout: Task<Void, Never>?

    @Published var frozenListState: FrozenListState = .idle
    @Published var frozenSessions: [FrozenSessionIndexEntry] = []
    
    
    
    @Published var frozenOpeningId: String?
    
    
    @Published var openFrozen: OpenFrozenSession?
    @Published var frozenOpenError: String?

    
    
    
    func requestNewSession(_ action: NewSessionAction) {
        guard !newSessionInFlight else { return }
        guard sendToLeader(.newSession(action: action)) else { return }
        newSessionInFlight = true
        
        
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
        
        
        leaderTheme = nil
        
        
        activeJoinUrl = trimmed
        activeDisplayName = displayName

        
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

    
    
    func disconnect() {
        
        
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        clearTrayCredentials()
        fileProviderDomainLifecycle.removeDomain()
        tearDown()
        resetCDPState()
        
        
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
        
        
        
        VoiceReply.shared.reset()
        DictationPriming.reset()
        
        
        fileMentionResolver.reset()
        TranscriptInlineCache.shared.clear()
        scoops = []
        resetComputers()
        selectedScoopJid = nil
        leaderActiveScoopJid = nil
        leaderProtocolVersion = nil
        modelCatalog = []
        modelSelectionState = nil
        messagesByScoop.removeAll()
        localSends.removeAll()
        toolProgress.removeAll()
        sprinkles = []
        sprinkleContents.removeAll()
        sprinkleUpdates.removeAll()
        pendingSprinkleFetches.removeAll()
        inflightSprinkleNameToRequest.removeAll()
        
        let waiters = sprinkleContentWaiters
        sprinkleContentWaiters.removeAll()
        for (_, list) in waiters {
            for waiter in list {
                waiter.resume(throwing: SprinkleFetchError.fetchFailed("Disconnected"))
            }
        }
        
        
        fsClient.cancelAll()
        
        
        
        
        
        clearWidgetSnapshot()
    }

    
    
    
    private func resetCDPState() {
        stopTargetsAdvertiseTimer()
        cdpBridge?.reset()
        cdpBridge = nil
        cdpTargets.removeAll()
        
        
        
        remoteTargets.removeAll()
    }

    

    
    
    
    
    func sendMessage(
        _ text: String, steer: Bool = false, attachments: [MessageAttachment]? = nil,
        dictated: Bool = false
    ) {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let attached = (attachments?.isEmpty == false) ? attachments : nil
        
        
        guard !trimmed.isEmpty || attached != nil else { return }
        
        
        
        guard !selectedUnitIsReadOnly else { return }

        
        
        let dictationScoop = selectedScoopJid ?? ""
        if dictated {
            
            
            
            
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
        
        if let jid = selectedScoopJid {
            messagesByScoop[jid, default: []].append(message)
        }
        localSends.record(message, scoopJid: selectedScoopJid)

        let msg = FollowerToLeaderMessage.userMessage(
            text: trimmed, messageId: messageId, steer: steer, attachments: attached)
        #if DEBUG
            
            
            
            let hermeticallyConnected = UITestHooks.forcedConnectionState != nil
        #else
            let hermeticallyConnected = false
        #endif
        if !sendToLeader(msg), !hermeticallyConnected {
            markUndelivered(messageId)
            
            
            
            
            if dictated { VoiceReply.shared.rollbackSubmission(scoopJid: dictationScoop) }
        } else if dictated {
            DictationPriming.commitFirst()
        }
    }

    
    func abort() {
        isStreaming = false
        streamingMessageId = nil
        sendToLeader(.abort)
    }

    

    
    func refreshSprinkles() {
        sendToLeader(.sprinklesRefresh)
    }

    
    
    
    func fetchSprinkleContent(_ sprinkleName: String) async throws -> String {
        if let cached = sprinkleContents[sprinkleName] { return cached }
        let requestId = UUID().uuidString
        
        if inflightSprinkleNameToRequest[sprinkleName] == nil {
            inflightSprinkleNameToRequest[sprinkleName] = requestId
            pendingSprinkleFetches[requestId] = SprinkleFetchBuffer(sprinkleName: sprinkleName)
            sendToLeader(.sprinkleFetch(requestId: requestId, sprinkleName: sprinkleName))
        }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            sprinkleContentWaiters[sprinkleName, default: []].append(continuation)
        }
    }

    
    
    
    
    
    
    
    
    
    
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

    
    
    
    nonisolated static func handoffFingerprint(_ match: HandoffMatch) -> String {
        [
            match.verb.rawValue, match.target, match.branch ?? "", match.path ?? "",
            match.instruction ?? "",
        ].joined(separator: "\0")
    }

    
    func sendSprinkleLick(_ sprinkleName: String, body: AnyCodable?, targetScoop: String? = nil) {
        sendToLeader(
            .sprinkleLick(
                sprinkleName: sprinkleName,
                body: body,
                targetScoop: targetScoop
            ))
    }

    
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

    

    
    func dataChannelOpened() {
        logger.info("Data channel opened")
        connectionState = .connected
        let connectedAt = Date()
        connectedSince = connectedAt
        leaderProtocolVersion = nil
        leaderCapabilities = nil
        leaderMotd = nil
        threadSync.reset()
        modelCatalog = []
        modelSelectionState = nil
        let credentialsSaved = persistTrayCredentials(connectedAt: connectedAt)
        
        
        
        recentJoinStore.record(joinUrl: activeJoinUrl, label: activeDisplayName ?? "")
        fileProviderDomainLifecycle.registerIfCredentialsAvailable(credentialsSaved)
        Task { await VoiceReply.shared.prewarm() }

        
        
        
        
        let bridge = ensureCdpBridge()
        
        
        bridge.advertiseTargets()
        refreshCDPTargets()
        startTargetsAdvertiseTimer()

        
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
            
            
            
            isTransportOpen: { [weak rtc] in rtc?.isConnected ?? false },
            onStalled: { [weak self] in
                Task { @MainActor [weak self] in self?.isLeaderStalled = true }
            },
            onRecovered: { [weak self] in
                Task { @MainActor [weak self] in self?.isLeaderStalled = false }
            }
        )
        Task { await keepalive?.start() }

        
        sendToLeader(
            .hello(
                protocolVersion: traySyncProtocolVersion,
                runtime: "slicc-ios",
                capabilities: followerCapabilities(),
                motd: trayFollowerMotd,
                pairId: nil))
        openApprovalController.transportAvailable()
        startPushRegistration()

        
        
        sendToLeader(snapshotRequestForConnection())
    }

    
    
    
    
    
    func handleDataChannelMessage(_ data: Data) {
        if let frame = try? JSONDecoder().decode(TrayChunkFrame.self, from: data),
            frame.type == TrayChunkFrame.typeTag
        {
            acceptChunkFrame(frame)
            return
        }
        routeLeaderMessage(data)
    }

    
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
            if !localSends.owns(messageId), !buffer.contains(where: { $0.id == messageId }) {
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
            
            isStreaming = ["processing", "streaming", "running"].contains(scoopStatus)
            if wasStreaming && !isStreaming {
                streamingMessageId = nil
            }

        case .error(let error):
            logger.error("Leader error: \(error)")
            leaderError = error

        case .scoopsList(let scoops, let activeScoopJid):
            logger.info("Scoops list received: \(scoops.count) scoops, active=\(activeScoopJid)")
            let previousRoster = self.scoops
            self.scoops = scoops
            self.leaderActiveScoopJid = activeScoopJid
            publishWidgetSnapshot()
            
            let preservedScoopExists =
                selectedScoopJid.map { selected in
                    scoops.contains(where: { $0.jid == selected })
                } ?? false
            if selectedScoopJid == nil || !preservedScoopExists {
                let hadMissingSelection = selectedScoopJid != nil
                let cone = scoops.first(where: { $0.isRootUnit })
                let initial = hadMissingSelection ? activeScoopJid : (cone?.jid ?? activeScoopJid)
                if !initial.isEmpty {
                    selectedScoopJid = initial
                    
                    
                    if hadMissingSelection || messagesByScoop[initial] == nil {
                        sendToLeader(.scoopsSelect(scoopJid: initial))
                    } else {
                        messages = messagesByScoop[initial] ?? []
                    }
                    refreshModels()
                }
            }
            threadRosterChanged(from: previousRoster)

        case .computersList, .computerFrame, .computerNativeCapture, .computerNativeUnwatch,
            .computerNativeInput:
            handleComputerLeaderMessage(msg)

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
            
            
            
            leaderOpenedTabId = cdpBridge?.handleTabOpen(requestId: requestId, url: url)

        case .previewOpen(let requestId, let url):
            
            
            
            
            
            logger.info(
                "\(SafeLeaderMessageLog.urlEventSummary("Leader requested preview tab", url: url))")
            cdpBridge?.handleTabOpen(requestId: requestId, url: url)

        case .targetsRegistry(let targets):
            
            
            
            
            
            
            
            
            
            
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
            
            
            
            logger.debug("Ignoring cherry.slicc_event for target=\(targetId) name=\(name) (cherry pages not hosted on iOS)")

        case .fsRequest(let requestId, let request):
            
            
            
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
            
            logger.warning("Unknown leader message type — skewed leader? type=\(type)")
        }
    }

    
    
    
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

    
    
    let inboundPrompt = InboundPromptWaiter()
    
    let inboundSnapshot = InboundSnapshotWaiter()

    
    
    
    
    
    
    
    
    
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

    
    private func refreshCDPTargets() {
        cdpTargets = cdpBridge?.currentTargets() ?? []
        
        
        SliccTabRegistry.shared.publish(cdpTargets)
        
        
        
        if let viewing = browserViewingTabId, !cdpTargets.contains(where: { $0.id == viewing }) {
            browserViewingTabId = nil
        }
    }

    
    
    func cdpWebView(for targetId: String) -> WKWebView? {
        cdpBridge?.webView(for: targetId)
    }

    
    
    
    
    
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

    
    
    @discardableResult
    func cdpOpenTab(url: String = "about:blank") -> String {
        ensureCdpBridge().openTab(url: url)
    }

    
    func cdpNavigate(_ targetId: String, to url: String) {
        cdpBridge?.navigate(targetId: targetId, to: url)
    }

    
    func cdpCloseTab(_ targetId: String) {
        cdpBridge?.handleRequest(
            requestId: "ui-close-\(UUID().uuidString)",
            localTargetId: targetId,
            method: "Target.closeTarget",
            params: AnyCodable(["targetId": targetId]),
            sessionId: nil
        )
    }

    
    func cdpBridgeReload(_ targetId: String) {
        cdpBridge?.handleRequest(
            requestId: "ui-reload-\(UUID().uuidString)",
            localTargetId: targetId,
            method: "Page.reload",
            params: nil,
            sessionId: nil
        )
    }

    
    
    private func ingestSnapshot(messages chatMessages: [ChatMessage], scoopJid: String) {
        
        
        
        
        
        
        let isViewed = selectedScoopJid == nil || scoopJid == selectedScoopJid
        if newSessionInFlight && chatMessages.isEmpty && isViewed {
            newSessionInFlight = false
            newSessionTimeout?.cancel()
            
            
            
            VoiceReply.shared.reset()
            DictationPriming.reset()
            localSends.removeAll()
        }
        
        
        let chatMessages = localSends.reconcile(snapshot: chatMessages, scoopJid: scoopJid)
        pruneToolProgress(replacing: messagesByScoop[scoopJid] ?? [], with: chatMessages)
        messagesByScoop[scoopJid] = chatMessages
        
        
        
        
        if isViewed { toolUICards.removeAll() }
        if selectedScoopJid == nil { selectedScoopJid = scoopJid }
        threadSnapshotArrived(for: scoopJid)
        if scoopJid == selectedScoopJid {
            
            
            if messages != chatMessages { messages = chatMessages }
            isStreaming = chatMessages.last?.isStreaming == true
            streamingMessageId = isStreaming ? chatMessages.last?.id : nil
        }
    }

    
    private func handleAgentEvent(_ event: AgentEvent, scoopJid: String) {
        var buffer = messagesByScoop[scoopJid] ?? []
        let isVisible = (scoopJid == selectedScoopJid)

        switch event {
        case .messageStart(let messageId):
            logger.info("Agent event: message_start id=\(messageId) scoop=\(scoopJid)")
            
            
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
                publishWidgetSnapshot()
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
                
                
                if isError == true { avatarExpression.glower() }
            }
            applyToolResult(
                messageId: messageId, toolName: toolName, result: result, isError: isError,
                toolCallId: toolCallId, buffer: &buffer, scoopJid: scoopJid, isVisible: isVisible)

        
        
        
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

        
        
        
        
        
        
        case .compactionNotice(let messageId, let marker):
            logger.info(
                "Agent event: compaction_notice id=\(messageId) state=\(marker.state.rawValue)")
            applyCompactionNotice(
                messageId: messageId, marker: marker, buffer: &buffer, scoopJid: scoopJid,
                isVisible: isVisible)

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

        
        
        
        
        case .toolUI, .toolUIDone, .screenshot, .terminalOutput, .unknown:
            handleNonTranscriptAgentEvent(event, scoopJid: scoopJid)
        }
    }

    
    private func settleTurn(messageId: String?, isVisible: Bool) {
        guard isVisible, let activeMessageId = streamingMessageId else { return }
        guard messageId == nil || messageId == activeMessageId else { return }
        isStreaming = false
        streamingMessageId = nil
    }

    
    
    
    
    
    
    private func handleNonTranscriptAgentEvent(_ event: AgentEvent, scoopJid: String) {
        switch event {
        case .toolUI(let messageId, let toolName, let requestId, let html):
            
            
            
            
            
            
            guard scoops.first(where: { $0.jid == scoopJid })?.isReadOnly != true else {
                logger.debug("Ignoring tool_ui for read-only unit \(scoopJid)")
                return
            }
            logger.debug(
                "Agent event: tool_ui id=\(messageId) tool=\(toolName) request=\(requestId)"
            )
            let card = ToolUIPlaceholder(requestId: requestId, html: html)
            
            if let existing = toolUICards.firstIndex(where: { $0.id == requestId }) {
                toolUICards[existing] = card
            } else {
                toolUICards.append(card)
            }
        case .toolUIDone(let messageId, let requestId):
            logger.debug("Agent event: tool_ui_done id=\(messageId) request=\(requestId)")
            
            
            toolUICards.removeAll { $0.id == requestId }
        case .screenshot, .terminalOutput:
            break
        default:
            logger.debug("Agent event: unknown type")
        }
    }

    

    
    
    
    
    
    
    
    
    
    
    
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

    

    
    
    
    private static let messagesFlushIntervalNs: UInt64 = 33_000_000

    
    
    private func scheduleMessagesFlush(for scoopJid: String) {
        guard pendingMessagesFlush == nil else { return }
        pendingMessagesFlush = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: AppState.messagesFlushIntervalNs)
            guard let self else { return }
            self.pendingMessagesFlush = nil
            
            
            if self.selectedScoopJid == scoopJid,
                let buffer = self.messagesByScoop[scoopJid]
            {
                self.messages = buffer
            }
        }
    }

    
    
    
    
    func cancelPendingMessagesFlush() {
        pendingMessagesFlush?.cancel()
        pendingMessagesFlush = nil
    }

    

    
    func handleDisconnect(reason: String) {
        guard connectionState == .connected || connectionState == .reconnecting else { return }

        openApprovalController.disconnect()
        sudoApprovalController.transportLost()
        terminalClient.disconnect()

        
        
        
        
        
        
        
        
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

    
    
    
    
    
    private func runReconnectLoop(initialReason: String) async {
        for attempt in 1...ReconnectBackoff.maxAttempts {
            reconnectAttempt = attempt
            connectionState = .reconnecting

            let delay = ReconnectBackoff.delay(forAttempt: attempt)
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            
            
            guard connectionState == .reconnecting else { return }

            connect(to: activeJoinUrl, displayName: activeDisplayName)

            
            
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



extension AppState {
    
    
    
    
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
        
        
        stopTargetsAdvertiseTimer()
    }

}

extension AppState {
    
    func clearStoredData() {
        
        
        recentJoinStore.clearLocalHistory()
        credentialStore.clear()
        fileProviderDomainLifecycle.removeDomain()
        Self.purgeLegacyJoinURLDefaults()
        openApprovalController.revokeAllGrants()
    }

    fileprivate static func purgeLegacyJoinURLDefaults() {
        
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






extension AppState {
    
    func connect() {
        connect(to: joinUrl, displayName: nil)
    }

    
    
    
    func connectToDiscoveredSession(joinUrl url: String, displayName: String? = nil) {
        connect(to: url, displayName: displayName)
    }

    
    
    
    
    
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



extension AppState {
    
    
    
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
        
    }

    func webRTCManager(_ manager: WebRTCManager, didGenerateLocalCandidate candidate: RTCIceCandidate) {
        Task { @MainActor [weak self] in
            guard let self, let appState = self.appState else { return }
            
            guard let client = appState.signalingClient else { return }
            let trayCandidate = TrayIceCandidate(
                candidate: candidate.sdp,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: Int(candidate.sdpMLineIndex),
                usernameFragment: nil
            )
            
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



enum AppStateError: LocalizedError {
    case attachFailed(String)

    var errorDescription: String? {
        switch self {
        case .attachFailed(let reason):
            return "Failed to attach to tray: \(reason)"
        }
    }
}






extension AppState {
    
    private func runSignalingLoop(client: TraySignalingClient, rtc: WebRTCManager) async {
        do {
            
            
            
            
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

            
            rtc.configure(iceServers: iceServers)

            
            let bootstrapId = bootstrap.bootstrapId
            self.currentBootstrapId = bootstrapId
            var cursor: Int? = bootstrap.cursor

            
            

            var gotOffer = false
            let maxPolls = 60  
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

                
                if poll.bootstrap.state == .connected {
                    break
                }

                
                
                if gotOffer && poll.events.isEmpty {
                    
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }

                
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

            
            
            
            
            
            if plan.supersededByJoinUrl != nil {
                let outcome = SupersedeRedirect.outcome(
                    for: plan, redirectsFollowed: redirectsFollowed)
                guard case .follow(let replacement) = outcome else {
                    throw AppStateError.attachFailed(
                        SupersedeRedirect.failureMessage(for: outcome)
                            ?? plan.error ?? plan.code)
                }
                redirectsFollowed += 1
                client = followSuperseded(to: replacement)
                try await Task.sleep(
                    nanoseconds: UInt64(SupersedeRedirect.delaySeconds * 1_000_000_000))
                continue
            }

            switch plan.action {
            case .signal:
                return (plan, client)
            case .wait:
                waitAttempts += 1
                let delay = plan.retryAfterMs ?? 2000
                try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            case .fail:
                throw AppStateError.attachFailed(plan.error ?? plan.code)
            }
        }
        throw AppStateError.attachFailed("Max attach retries exceeded")
    }

    
    
    
    
    
    private func followSuperseded(to replacement: URL) -> TraySignalingClient {
        logger.info("Tray superseded; following redirect to the replacement tray")
        controllerId = UUID().uuidString
        activeJoinUrl = replacement.absoluteString
        let client = TraySignalingClient(joinUrl: replacement)
        signalingClient = client
        return client
    }
}
