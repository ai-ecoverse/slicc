import Foundation
import SliccTrayKit
import SliccTraySession
import UIKit

#if DEBUG
    
    
    
    
    
    
    
    
    
    
    
    enum UITestHooks {
        
        
        static var inboundOpenURL: URL? {
            UserDefaults.standard.string(forKey: "uiTestInboundOpenURL")
                .flatMap(URL.init(string:))
        }

        
        
        
        static var launchJoinUrl: String? {
            UserDefaults.standard.string(forKey: "joinUrl")
        }

        
        
        static var routesToFixture: Bool {
            UserDefaults.standard.bool(forKey: "uiTestFixtureRoute")
        }

        
        
        
        
        
        
        
        static var avatarFixtureVariant: String? {
            UserDefaults.standard.string(forKey: "uiTestAvatarFixture")
        }

        
        
        
        static func scoopStatusFixture() -> [ScoopSummary]? {
            guard UserDefaults.standard.bool(forKey: "uiTestScoopStatusFixture") else {
                return nil
            }
            return [
                scoop(jid: "fixture-working", label: "Working Scoop", state: "working", fill: 64),
                scoop(jid: "fixture-broken", label: "Broken Scoop", state: "broken", fill: 82),
                scoop(
                    jid: "fixture-initializing", label: "Initializing Scoop",
                    state: "initializing", fill: 12),
                scoop(jid: "fixture-idle", label: "Idle Scoop", state: "idle", fill: 0),
                scoop(
                    jid: "fixture-near-limit", label: "Near Limit Scoop", state: "idle",
                    fill: 95),
                scoop(jid: "fixture-low-fill", label: "Low Fill Scoop", state: "idle", fill: 5),
                scoop(jid: "fixture-unknown", label: "Unknown Scoop", state: nil, fill: nil),
                scoop(jid: "fixture-short", label: "S", state: "idle", fill: 20),
                scoop(
                    jid: "fixture-long",
                    label: "Scoop with a deliberately overlong assistant label",
                    state: "idle", fill: 20),
            ]
        }

        
        
        
        
        
        
        
        
        
        
        @MainActor
        static func applyUnitRoleFixture(into appState: AppState) -> Bool {
            
            
            if applyThreadListFixture(into: appState) { return true }
            guard let variant = UserDefaults.standard.string(forKey: "uiTestUnitRoleFixture"),
                !variant.isEmpty, variant != "NO"
            else {
                return false
            }
            let cone = ScoopSummary(
                jid: "fixture-cone", name: "cone", folder: "/workspace", isCone: true,
                assistantLabel: "sliccy", trigger: nil, state: "idle", fill: 20)
            let scoop = ScoopSummary(
                jid: "fixture-owned-scoop", name: "reviewer", folder: "/scoops/reviewer",
                isCone: false, assistantLabel: "reviewer", trigger: nil, state: "working",
                fill: 40, parentId: "fixture-cone")
            appState.scoops = [cone, scoop]
            
            
            
            let repeats = UserDefaults.standard.integer(forKey: "uiTestTranscriptRepeat")
            let coneMessages =
                repeats > 0
                ? repeatedTranscript(ChatFixture.makeMessages(), times: repeats)
                : [reply(id: "fixture-cone-reply", text: "Sent the review to a scoop.")]
            
            
            let scoopReply = reply(
                id: "fixture-scoop-reply",
                text: "Reviewed 14 files. Two findings, both in the follower.")
            let scoopMessages =
                repeats > 0
                ? repeatedTranscript(ChatFixture.makeMessages(), times: max(repeats / 6, 2))
                    .map { message in
                        ChatMessage(
                            id: "s-\(message.id)", role: message.role, content: message.content,
                            timestamp: message.timestamp)
                    } + [scoopReply]
                : [scoopReply]
            appState.messagesByScoop = [
                cone.jid: coneMessages,
                scoop.jid: scoopMessages,
            ]
            let selected = variant == "scoop" ? scoop : cone
            appState.selectedScoopJid = selected.jid
            appState.leaderActiveScoopJid = cone.jid
            appState.messages = appState.messagesByScoop[selected.jid] ?? []
            return true
        }

        private static func reply(id: String, text: String) -> ChatMessage {
            ChatMessage(
                id: id, role: .assistant, content: text,
                timestamp: 1_756_000_000_000)
        }

        
        
        
        
        
        static var reducesMotion: Bool {
            UserDefaults.standard.bool(forKey: "uiTestReduceMotion")
                || avatarFixtureVariant?.hasSuffix("-static") == true
                || avatarFixtureVariant?.hasSuffix("-expression") == true
        }

        private static func scoop(
            jid: String, label: String, state: String?, fill: Double?
        ) -> ScoopSummary {
            ScoopSummary(
                jid: jid, name: jid, folder: "/scoops/\(jid)", isCone: false,
                assistantLabel: label, trigger: nil, state: state, fill: fill)
        }

        
        
        
        
        
        
        
        static var forcedConnectionState: String? {
            UserDefaults.standard.string(forKey: "uiTestConnectionState")
        }

        
        
        
        
        
        
        
        
        static var connectionBlip: (dropAfter: TimeInterval, healsAfter: TimeInterval?)? {
            guard let raw = UserDefaults.standard.string(forKey: "uiTestConnectionBlip") else {
                return nil
            }
            let parts = raw.split(separator: ",").map {
                TimeInterval($0.trimmingCharacters(in: .whitespaces))
            }
            guard let first = parts.first, let dropAfter = first else { return nil }
            return (dropAfter, parts.count > 1 ? parts[1] : nil)
        }

        
        
        
        
        
        
        
        
        @MainActor
        static func seedTranscriptFixture(into appState: AppState) {
            guard UserDefaults.standard.bool(forKey: "uiTestTranscriptFixture") else { return }
            let scoopJid = "ui-test-cone"
            appState.selectedScoopJid = scoopJid
            let messages = repeatedTranscript(
                ChatFixture.makeMessages(),
                times: UserDefaults.standard.integer(forKey: "uiTestTranscriptRepeat"))
            appState.messagesByScoop[scoopJid] = messages
            appState.messages = messages
        }

        
        
        
        
        
        
        
        static func repeatedTranscript(_ base: [ChatMessage], times: Int) -> [ChatMessage] {
            var result: [ChatMessage] = []
            for pass in 1..<max(times, 1) {
                result += base.map { message in
                    ChatMessage(
                        id: "r\(pass)-\(message.id)", role: message.role,
                        content: message.content, timestamp: message.timestamp)
                }
            }
            result += base
            if UserDefaults.standard.bool(forKey: "uiTestTranscriptTallTail") {
                let paragraph =
                    "One thing I want to flag about my own reporting. I read an "
                    + "implementation and quoted a constant from it, and it was the "
                    + "implementation that was not running. `which` would have taken a second."
                result.append(
                    ChatMessage(
                        id: "fx-tall-tail", role: .assistant,
                        content: (1...14).map { "\($0). \(paragraph)" }.joined(separator: "\n\n"),
                        timestamp: base.last?.timestamp ?? 0))
            }
            return result
        }

        
        
        
        
        
        
        
        @MainActor
        static func seedShortActionsFixture(into appState: AppState) {
            guard UserDefaults.standard.bool(forKey: "uiTestShortActionsFixture") else { return }
            let scoopJid = "ui-test-cone"
            appState.selectedScoopJid = scoopJid
            let messages = ChatFixture.makeShortActionMessages()
            appState.messagesByScoop[scoopJid] = messages
            appState.messages = messages
        }

        
        
        
        
        @MainActor
        static func scheduleTranscriptAppend(into appState: AppState) {
            let delay = UserDefaults.standard.double(forKey: "uiTestTranscriptAppendAfter")
            guard delay > 0 else { return }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(delay))
                let message = ChatMessage(
                    id: "fx-appended-while-reading",
                    role: .assistant,
                    content: "An incoming message that arrived while you were reading back.",
                    timestamp: Date().timeIntervalSince1970 * 1000)
                appState.messages.append(message)
                if let jid = appState.selectedScoopJid {
                    appState.messagesByScoop[jid, default: []].append(message)
                }
            }
        }

        
        
        
        
        @MainActor
        static func scriptCompletedTurn(into appState: AppState) -> Bool {
            guard UserDefaults.standard.bool(forKey: "uiTestCompletedTurn") else { return false }
            let scoopJid = "ui-test-cone"
            let messageId = "ui-test-reply"
            appState.connectionState = .connected
            appState.selectedScoopJid = scoopJid
            let messages: [LeaderToFollowerMessage] = [
                .agentEvent(event: .messageStart(messageId: messageId), scoopJid: scoopJid),
                .agentEvent(
                    event: .contentDelta(messageId: messageId, text: "Stable layout fixture"),
                    scoopJid: scoopJid),
                .agentEvent(
                    event: .contentDone(messageId: messageId, model: nil, usage: nil),
                    scoopJid: scoopJid),
                .status(scoopStatus: "ready", scoopJid: scoopJid),
            ]
            for message in messages {
                guard let data = try? JSONEncoder().encode(message) else { return false }
                appState.handleDataChannelMessage(data)
            }
            if let raw = forcedConnectionState, let state = ConnectionState(rawValue: raw) {
                appState.connectionState = state
            }
            
            
            appState.settleConnectionImmediately()
            return true
        }

        
        
        
        
        
        
        
        
        
        
        
        static func sessionsFixtureBackend(
            defaults: UserDefaults = .standard
        ) -> KeyValueSyncBackend? {
            if defaults.bool(forKey: "uiTestSessionsEmpty") {
                return InMemoryKeyValueBackend()
            }
            guard defaults.bool(forKey: "uiTestSessionsFixture") else { return nil }
            let backend = InMemoryKeyValueBackend()
            let now = Date()
            seed(
                backend,
                deviceId: "fixture-macbook",
                sessions: [
                    SyncedTraySession(
                        joinUrl: "http://127.0.0.1:1/join/fixture-chrome",
                        label: "Chrome on Fixture MacBook",
                        deviceId: "fixture-macbook",
                        deviceName: "Fixture MacBook",
                        createdAt: now.addingTimeInterval(-3600),
                        lastSeenAt: now.addingTimeInterval(-60)
                    ),
                    SyncedTraySession(
                        joinUrl: "http://127.0.0.1:1/join/fixture-edge",
                        label: "Edge on Fixture MacBook",
                        deviceId: "fixture-macbook",
                        deviceName: "Fixture MacBook",
                        createdAt: now.addingTimeInterval(-7200),
                        lastSeenAt: now.addingTimeInterval(-7200)
                    ),
                ]
            )
            seed(
                backend,
                deviceId: "fixture-studio",
                sessions: [
                    SyncedTraySession(
                        joinUrl: "http://127.0.0.1:1/join/fixture-studio",
                        label: "Chrome on Fixture Studio",
                        deviceId: "fixture-studio",
                        deviceName: "Fixture Studio",
                        createdAt: now.addingTimeInterval(-300),
                        lastSeenAt: now.addingTimeInterval(-300)
                    )
                ]
            )
            return backend
        }

        private static func seed(
            _ backend: KeyValueSyncBackend,
            deviceId: String,
            sessions: [SyncedTraySession]
        ) {
            guard let data = try? JSONEncoder().encode(sessions) else { return }
            backend.setData(data, forKey: TraySessionSyncStore.storageKeyPrefix + deviceId)
        }

        
        
        
        
        
        
        
        
        static func recentJoinsFixtureBackend(
            defaults: UserDefaults = .standard
        ) -> KeyValueSyncBackend? {
            if defaults.bool(forKey: "uiTestRecentJoinsEmpty") {
                return InMemoryKeyValueBackend()
            }
            guard defaults.bool(forKey: "uiTestRecentJoinsFixture") else {
                return nil
            }
            let backend = InMemoryKeyValueBackend()
            let now = Date()
            seed(
                backend,
                deviceId: "ios-under-test",
                recents: [
                    RecentJoin(
                        joinUrl: "http://127.0.0.1:1/join/fixture-recent-local",
                        
                        
                        label: "Safari on Fixture MacBook",
                        deviceId: "ios-under-test",
                        deviceName: "iPhone Under Test",
                        firstConnectedAt: now.addingTimeInterval(-86_400),
                        lastConnectedAt: now.addingTimeInterval(-600)
                    )
                ]
            )
            seed(
                backend,
                deviceId: "fixture-ipad",
                recents: [
                    
                    RecentJoin(
                        joinUrl: "http://127.0.0.1:1/join/fixture-recent-pasted",
                        label: "",
                        deviceId: "fixture-ipad",
                        deviceName: "Fixture iPad",
                        firstConnectedAt: now.addingTimeInterval(-7_200),
                        lastConnectedAt: now.addingTimeInterval(-3_600)
                    )
                ]
            )
            return backend
        }

        private static func seed(
            _ backend: KeyValueSyncBackend,
            deviceId: String,
            recents: [RecentJoin]
        ) {
            guard let data = try? JSONEncoder().encode(recents) else { return }
            backend.setData(data, forKey: RecentJoinStore.storageKeyPrefix + deviceId)
        }

        
        
        static var opensFrozenRail: Bool {
            UserDefaults.standard.bool(forKey: "uiTestOpenFrozenRail")
        }
        static var opensFrozenSession: Bool {
            UserDefaults.standard.bool(forKey: "uiTestOpenFrozenSession")
        }

        
        
        
        static func frozenFixture() -> [FrozenSessionIndexEntry]? {
            if UserDefaults.standard.bool(forKey: "uiTestFrozenEmpty") { return [] }
            guard UserDefaults.standard.bool(forKey: "uiTestFrozenFixture") else { return nil }
            return [
                FrozenSessionIndexEntry(
                    filename: "2026-07-30T10-00-00Z-fix-the-build.md",
                    title: "Fix the build",
                    frozenAt: "2026-07-30T10:00:00Z",
                    messageCount: 12,
                    sessionId: "fixture-frozen-1"
                ),
                FrozenSessionIndexEntry(
                    filename: "2026-07-01T09-00-00Z-plan-the-launch.md",
                    title: "Plan the launch",
                    frozenAt: "2026-07-01T09:00:00Z",
                    messageCount: 4,
                    sessionId: "fixture-frozen-2"
                ),
            ]
        }

        
        
        
        
        
        
        
        static func speechEngine() -> DictationEngine? {
            guard let raw = UserDefaults.standard.string(forKey: "uiTestSpeechPermission"),
                let permission = parsePermission(raw)
            else { return nil }
            let script = UserDefaults.standard.string(forKey: "uiTestSpeechScript") ?? ""
            let grantRaw = UserDefaults.standard.string(forKey: "uiTestSpeechGrant") ?? "granted"
            let grant = parsePermission(grantRaw) ?? .granted
            return ScriptedDictationEngine(
                permission: permission, grantOutcome: grant, script: script)
        }

        
        
        
        static func filesFixture(path: String) -> [TrayFsDirEntry]? {
            guard UserDefaults.standard.bool(forKey: "uiTestFilesFixture") else { return nil }
            switch path {
            case "/":
                return [
                    TrayFsDirEntry(name: "workspace", type: .directory),
                    TrayFsDirEntry(name: "shared", type: .directory),
                    TrayFsDirEntry(name: "README.md", type: .file),
                ]
            case "/workspace":
                return [
                    TrayFsDirEntry(name: "CLAUDE.md", type: .file),
                    TrayFsDirEntry(name: "notes.txt", type: .file),
                ]
            default:
                return []
            }
        }

        
        
        
        static func remoteTargetsFixture() -> [TrayTargetEntry]? {
            guard UserDefaults.standard.bool(forKey: "uiTestRemoteTargetsFixture") else {
                return nil
            }
            return [
                TrayTargetEntry(
                    targetId: "leader:tab-docs", localTargetId: "tab-docs",
                    runtimeId: "leader", title: "Sliccy docs — architecture",
                    url: "https://www.sliccy.ai/docs/architecture", isLocal: false),
                TrayTargetEntry(
                    targetId: "cli:tab-ci", localTargetId: "tab-ci",
                    runtimeId: "slicc-cli-a1b2", title: "CI dashboard",
                    url: "https://github.com/ai-ecoverse/slicc/actions", isLocal: false),
            ]
        }

        
        
        static func computersFixture() -> [ComputerDescriptor]? {
            guard UserDefaults.standard.bool(forKey: "uiTestComputersFixture") else {
                return nil
            }
            let caps = ComputerCapabilities(
                screenshot: true, text: false, frames: "poll", keyboard: true, mouse: "absolute",
                scroll: true, exec: false, inputAllowed: true)
            return [
                ComputerDescriptor(
                    id: "ssh:sliccstart-computer-1", kind: "ssh", title: "Desk",
                    size: ComputerSize(width: 1920, height: 1080), state: "live",
                    capabilities: caps, pid: nil,
                    softKeys: [ComputerSoftKey(label: "Home", keysym: "Home")]),
                ComputerDescriptor(
                    id: "jsh:clock", kind: "jsh", title: "Clock",
                    size: ComputerSize(width: 640, height: 400), state: "live",
                    capabilities: caps, pid: nil, softKeys: nil),
            ]
        }

        static func computerPreviewFixtureImage() -> UIImage? {
            guard UserDefaults.standard.bool(forKey: "uiTestComputersFixture") else {
                return nil
            }
            let size = CGSize(width: 480, height: 270)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.systemTeal.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                UIColor.white.setFill()
                context.fill(CGRect(x: 24, y: 24, width: 432, height: 40))
                context.fill(CGRect(x: 24, y: 84, width: 280, height: 16))
            }
        }

        static func remotePreviewFixtureImage() -> UIImage? {
            guard UserDefaults.standard.bool(forKey: "uiTestRemoteTargetsFixture") else {
                return nil
            }
            let size = CGSize(width: 480, height: 280)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.systemIndigo.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                UIColor.white.setFill()
                context.fill(CGRect(x: 24, y: 24, width: 432, height: 40))
                context.fill(CGRect(x: 24, y: 84, width: 320, height: 16))
                context.fill(CGRect(x: 24, y: 112, width: 380, height: 16))
            }
        }

        
        
        static func memoryFixtureMarkdown() -> String? {
            guard UserDefaults.standard.bool(forKey: "uiTestMemoryFixture") else { return nil }
            return """
                ## User Preferences

                - Prefers concise answers with code examples over prose.
                - Dark mode always; reduce motion enabled on the phone.

                ## Feedback & Corrections

                - Never auto-merge UI PRs; wait for a visual sign-off first.

                ## Project: iOS parity

                - The dock rail mirrors slicc-dock.ts order; tap-active collapses.
                """
        }

        
        
        
        static func opensDockSurface() -> DockSurface? {
            switch UserDefaults.standard.string(forKey: "uiTestOpenDockSurface") {
            case "browser": return .browser
            case "files": return .files
            case "term": return .term
            case "memory": return .memory
            case "monitor": return .monitor
            default: return nil
            }
        }

        
        
        
        static var terminalFixtureEnabled: Bool {
            UserDefaults.standard.bool(forKey: "uiTestTerminalFixture")
        }

        
        
        
        struct OpenApprovalFixture {
            let requestId: String
            let command: String
            let requesterIdentity: String
            let sessionIdentity: String
        }

        
        
        
        static func openApprovalFixture() -> OpenApprovalFixture? {
            guard stagesOpenApprovalFixture else { return nil }
            return OpenApprovalFixture(
                requestId: "ui-open-approval",
                command: "open --x-callback fixtureapp://calendar/create?secret=never-display",
                requesterIdentity: "Fixture Mac",
                sessionIdentity: "Fixture session")
        }

        static var stagesOpenApprovalFixture: Bool {
            UserDefaults.standard.bool(forKey: "uiTestOpenApproval")
        }

        
        
        
        static var stagesSudoApprovalFixture: Bool {
            UserDefaults.standard.bool(forKey: "uiTestSudoApproval")
        }

        
        
        
        
        static var stagesAttachmentFixture: Bool {
            UserDefaults.standard.bool(forKey: "uiTestAttachmentFixture")
        }

        
        
        
        static var kokoroModelState: KokoroModelInstallationState? {
            switch UserDefaults.standard.string(forKey: "uiTestKokoroState") {
            case "not-installed": return .notInstalled
            case "downloading": return .downloading(fraction: 0.42)
            case "installed": return .installed
            case "failed": return .failed(.offline("Connect to Wi-Fi and try again"))
            default: return nil
            }
        }

        
        static func attachmentFixtureImage() -> UIImage {
            let size = CGSize(width: 320, height: 200)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.systemIndigo.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                UIColor.systemTeal.setFill()
                context.fill(CGRect(x: 0, y: 120, width: 320, height: 80))
            }
        }

        
        
        
        
        
        static func themeFixtureJson() -> String? {
            switch UserDefaults.standard.string(forKey: "uiTestThemeFixture") {
            case "light":
                return #"{"id":"fixture-light","name":"Fixture Light","base":"light","tokens":{}}"#
            case "forest":
                return #"""
                    {"id":"fixture-forest","name":"Fixture Forest","base":"dark","tokens":{
                    "--canvas":"#0c1510","--bg":"#132019","--ghost":"#1b2c22",
                    "--ink":"#e8f2ec","--txt-2":"#9fb8a9","--txt-3":"#6d8577",
                    "--line":"#24382c","--ctx":"#34d399"}}
                    """#
            default:
                return nil
            }
        }

        
        
        
        
        
        static func pttStage() -> (stage: PttStage, caption: String)? {
            guard let raw = UserDefaults.standard.string(forKey: "uiTestPttStage") else {
                return nil
            }
            let caption = UserDefaults.standard.string(forKey: "uiTestPttCaption") ?? ""
            switch raw {
            case "enable": return (.enable, caption)
            case "prompting": return (.prompting, caption)
            case "denied": return (.denied(message: nil), caption)
            case "restricted":
                return (.denied(message: PttController.restrictedMessage), caption)
            case "recording": return (.recording, caption)
            case "finalizing": return (.finalizing, caption)
            default: return nil
            }
        }

        private static func parsePermission(_ raw: String) -> DictationPermission? {
            switch raw {
            case "granted": return .granted
            case "undetermined": return .undetermined
            case "denied": return .denied
            case "restricted": return .restricted
            default: return nil
            }
        }

        
        
        static func frozenArchiveFixture(for entry: FrozenSessionIndexEntry) -> String? {
            guard UserDefaults.standard.bool(forKey: "uiTestFrozenFixture") else { return nil }
            return """
                ---
                title: \(#""\#(entry.title)""#)
                frozenAt: \(entry.frozenAt)
                ---

                <!-- slicc:session-data
                [{"id":"m1","role":"user","content":"What did we ship?","timestamp":1753867200000},\
                {"id":"m2","role":"assistant","content":"The freezer rail, read-only on your phone.","timestamp":1753867260000}]
                -->

                # \(entry.title)

                ## User

                What did we ship?

                ## Assistant

                The freezer rail, read-only on your phone.
                """
        }
    }

    
    
    
    
    
    final class ScriptedDictationEngine: DictationEngine {
        private(set) var permission: DictationPermission
        private let grantOutcome: DictationPermission
        private let script: String

        init(permission: DictationPermission, grantOutcome: DictationPermission, script: String) {
            self.permission = permission
            self.grantOutcome = grantOutcome
            self.script = script
        }

        var statusLine: String { "Scripted test engine" }

        func requestPermission() async -> DictationPermission {
            permission = grantOutcome
            return grantOutcome
        }

        func start(
            onPartial: @escaping @MainActor @Sendable (String) -> Void,
            onError: @escaping @MainActor @Sendable (String) -> Void
        ) async throws -> DictationSession {
            ScriptedDictationSession(script: script, onPartial: onPartial)
        }
    }

    final class ScriptedDictationSession: DictationSession {
        private let script: String
        private let streamTask: Task<Void, Never>

        init(script: String, onPartial: @escaping @MainActor @Sendable (String) -> Void) {
            self.script = script
            let words = script.split(separator: " ").map(String.init)
            streamTask = Task { @MainActor in
                var heard: [String] = []
                for word in words {
                    try? await Task.sleep(nanoseconds: 120_000_000)
                    guard !Task.isCancelled else { return }
                    heard.append(word)
                    onPartial(heard.joined(separator: " "))
                }
            }
        }

        func stop() async -> String {
            streamTask.cancel()
            return script
        }

        func cancel() {
            streamTask.cancel()
        }
    }
#endif
