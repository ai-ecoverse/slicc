import Foundation
import SliccTraySession
import UIKit

#if DEBUG
    /// Launch-argument seams that let XCUITest reach a deterministic screen
    /// without a leader on the other end.
    ///
    /// These read the `UserDefaults` argument domain, the same mechanism the
    /// documented `-joinUrl` override uses (see `packages/ios-app/CLAUDE.md`).
    /// The argument domain outranks the persistent domain, so a test that
    /// passes a key explicitly is immune to whatever a previous run left on
    /// disk — which matters because the suite runs in random order.
    ///
    /// Compiled out of release builds. A shipped binary must not carry an
    /// argument that skips the connection path.
    enum UITestHooks {
        /// Route straight to `FixtureConversationView` and skip the join /
        /// connect path entirely, so no test needs a live WebRTC peer.
        static var routesToFixture: Bool {
            UserDefaults.standard.bool(forKey: "uiTestFixtureRoute")
        }

        /// Route straight to the isolated avatar matrix. The value selects the
        /// screenshot variant: `light-centered`, `light-offset`, `dark-centered`,
        /// or `dark-offset`.
        static var avatarFixtureVariant: String? {
            UserDefaults.standard.string(forKey: "uiTestAvatarFixture")
        }

        /// Force the connection banner into a given state. The stalled and
        /// gave-up states are otherwise only reachable by starving a real
        /// leader of pings or exhausting a real reconnect budget, neither of
        /// which a hermetic UI test can stage.
        ///
        /// Accepts a `ConnectionState` raw value; `stalled` additionally means
        /// "connected, but the leader stopped answering".
        static var forcedConnectionState: String? {
            UserDefaults.standard.string(forKey: "uiTestConnectionState")
        }

        /// Stage a completed visible turn without a leader
        /// (`-uiTestCompletedTurn YES`). Both events enter through the real
        /// data-channel decoder and agent-event dispatcher; the missing
        /// `turn_end` is deliberate so the composer settlement can regress.
        @MainActor
        static func scriptCompletedTurn(into appState: AppState) -> Bool {
            guard UserDefaults.standard.bool(forKey: "uiTestCompletedTurn") else { return false }
            let scoopJid = "ui-test-cone"
            let messageId = "ui-test-reply"
            appState.connectionState = .connected
            appState.selectedScoopJid = scoopJid
            let events: [AgentEvent] = [
                .messageStart(messageId: messageId),
                .contentDone(messageId: messageId, model: nil, usage: nil),
            ]
            for event in events {
                let message = LeaderToFollowerMessage.agentEvent(
                    event: event, scoopJid: scoopJid)
                guard let data = try? JSONEncoder().encode(message) else { return false }
                appState.handleDataChannelMessage(data)
            }
            return true
        }

        /// Seed the iCloud sessions list without touching iCloud:
        /// `-uiTestSessionsFixture YES` yields two devices' worth of fixture
        /// sessions, `-uiTestSessionsEmpty YES` a deterministic empty store.
        /// Join URLs dial 127.0.0.1:1 so a tap reaches Connection Failed
        /// hermetically, like the existing failure-state test.
        static func sessionsFixtureBackend() -> KeyValueSyncBackend? {
            if UserDefaults.standard.bool(forKey: "uiTestSessionsEmpty") {
                return InMemoryKeyValueBackend()
            }
            guard UserDefaults.standard.bool(forKey: "uiTestSessionsFixture") else { return nil }
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

        /// Present the freezer surfaces on launch (screenshots + tests that
        /// need the sheet or the frozen view without a tap).
        static var opensFrozenRail: Bool {
            UserDefaults.standard.bool(forKey: "uiTestOpenFrozenRail")
        }
        static var opensFrozenSession: Bool {
            UserDefaults.standard.bool(forKey: "uiTestOpenFrozenSession")
        }

        /// Seed the freezer rail without a leader: `-uiTestFrozenFixture YES`
        /// yields two archived sessions, `-uiTestFrozenEmpty YES` a
        /// deterministic empty list.
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

        /// A scripted dictation engine so push-to-talk UI tests never depend
        /// on a simulator microphone or the system permission prompts.
        /// `-uiTestSpeechPermission granted|undetermined|denied|restricted`
        /// selects the starting permission; `-uiTestSpeechScript "…"` is the
        /// transcript the fake session streams word by word;
        /// `-uiTestSpeechGrant denied` makes the in-app prompt resolve to a
        /// refusal (default: granted).
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

        /// Canned leader-VFS tree (`-uiTestFilesFixture YES`) so the files
        /// surface browses hermetically. Paths map to listings; file taps
        /// synthesize contents in the view.
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

        /// Seed federated remote tabs (`-uiTestRemoteTargetsFixture YES`)
        /// so the browser surface renders preview cards without a leader;
        /// the paired canned preview image stands in for a CDP capture.
        static func remoteTargetsFixture() -> [TrayTargetEntry]? {
            guard UserDefaults.standard.bool(forKey: "uiTestRemoteTargetsFixture") else {
                return nil
            }
            return [
                TrayTargetEntry(
                    targetId: "leader:tab-docs", localTargetId: "tab-docs",
                    runtimeId: "leader", title: "SLICC docs — architecture",
                    url: "https://www.sliccy.ai/docs/architecture", isLocal: false),
                TrayTargetEntry(
                    targetId: "cli:tab-ci", localTargetId: "tab-ci",
                    runtimeId: "slicc-cli-a1b2", title: "CI dashboard",
                    url: "https://github.com/ai-ecoverse/slicc/actions", isLocal: false),
            ]
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

        /// Canned memory markdown (`-uiTestMemoryFixture YES`) so the
        /// memory surface renders rows without a leader.
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

        /// Open a workbench surface on launch
        /// (`-uiTestOpenDockSurface term|files|memory|monitor|browser`)
        /// so screenshots and UI tests reach the dock overlay without taps.
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

        /// Replace leader execution with deterministic output
        /// (`-uiTestTerminalFixture YES`) while retaining the real Ghostty
        /// surface and keyboard path.
        static var terminalFixtureEnabled: Bool {
            UserDefaults.standard.bool(forKey: "uiTestTerminalFixture")
        }

        /// Stage a canned photo in the composer on launch
        /// (`-uiTestAttachmentFixture YES`): PhotosPicker runs out of
        /// process and cannot be driven hermetically, so attachment UI
        /// tests and screenshots seed the staging row directly.
        static var stagesAttachmentFixture: Bool {
            UserDefaults.standard.bool(forKey: "uiTestAttachmentFixture")
        }

        /// A deterministic 320x200 two-tone image (no bundled asset needed).
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

        /// Apply a canned leader theme on launch
        /// (`-uiTestThemeFixture light|forest`): `light` is a bare
        /// light-base theme (default light tokens), `forest` a custom token
        /// map, so screenshots and UI tests cover both the base flip and
        /// token-driven colors without a leader.
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

        /// Pin the push-to-talk overlay to a stage on launch
        /// (`-uiTestPttStage enable|prompting|denied|restricted|recording|finalizing`,
        /// with `-uiTestPttCaption` filling the recording caption line). The
        /// overlay otherwise exists only while a finger holds the composer,
        /// which a screenshot run cannot stage.
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

        /// The archive body backing the fixture entries — a modern archive
        /// with an intact `slicc:session-data` block.
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

    /// DEBUG-only dictation engine behind `-uiTestSpeechPermission`: the
    /// scripted transcript streams word by word as partials (like a real
    /// recognizer refining its interim result) and returns whole from
    /// `stop()`, so a UI test can hold, watch the caption, release, and
    /// assert the committed message — no microphone involved.
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
