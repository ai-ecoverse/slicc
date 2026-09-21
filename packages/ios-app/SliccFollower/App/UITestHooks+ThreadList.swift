import Foundation
import SliccTrayKit

#if DEBUG
    extension UITestHooks {
        /// `-uiTestThreadListFixture <variant>`: two cones with owned scoops
        /// (one nested a level deeper) carrying every thread-list marker —
        /// each lifecycle, both phases, awaiting, near-limit fill, a per-unit
        /// model, read-only scoops, a leader-active unit that is not the
        /// selected one. `scoop` starts on a scoop; any other value on the
        /// main cone. Unread needs a turn to END while you look elsewhere, so
        /// `scheduleThreadListTurns` plays two turns on `deploy-bot` after
        /// launch through the real `scoops.list` path.
        static var threadListFixtureVariant: String? {
            guard
                let variant = UserDefaults.standard.string(forKey: "uiTestThreadListFixture"),
                !variant.isEmpty, variant != "NO"
            else { return nil }
            return variant
        }

        /// `-uiTestThreadListOpen YES` starts with the slide-over open —
        /// screenshots of the open list without driving a tap.
        static var opensThreadList: Bool {
            UserDefaults.standard.bool(forKey: "uiTestThreadListOpen")
        }

        /// `-uiTestThreadSummaryDelay <milliseconds>` stands in for Apple's
        /// on-device model. The preview is still immediate; this long later
        /// every visible row receives the same short line, so a test can
        /// sample frames across the swap. Absent or zero keeps the real model.
        static var threadSummaryDelay: Duration? {
            let ms = UserDefaults.standard.integer(forKey: "uiTestThreadSummaryDelay")
            guard ms > 0 else { return nil }
            return .milliseconds(ms)
        }

        static func threadSummaryGenerator() -> ThreadSummaryGenerating? {
            guard let threadSummaryDelay else { return nil }
            return ScriptedThreadSummarizer(delay: threadSummaryDelay, line: "Pinned label")
        }

        /// `-uiTestShellWidth <pt>` pins the shell to a narrower window than
        /// the simulator's — the stand-in for an iPad Split View / Slide Over
        /// pane (and a foldable's side-by-side apps), which `simctl` cannot
        /// arrange. The shell reads only the width it is given, so this is
        /// the same input a real narrow pane produces.
        static var shellWidthOverride: CGFloat? {
            let width = UserDefaults.standard.double(forKey: "uiTestShellWidth")
            return width > 0 ? CGFloat(width) : nil
        }

        static let threadListMainCone = "fixture-cone-main"
        static let threadListDeployCone = "fixture-cone-deploy"
        static let threadListResearcher = "fixture-scoop-researcher"

        @MainActor
        static func applyThreadListFixture(into appState: AppState) -> Bool {
            guard let variant = threadListFixtureVariant else { return false }
            let scoops = threadListScoops(deployState: "working", deployActivity: "thinking")
            appState.scoops = scoops
            appState.messagesByScoop = Dictionary(
                uniqueKeysWithValues: scoops.map { scoop in
                    (
                        scoop.jid,
                        [
                            ChatMessage(
                                id: "\(scoop.jid)-reply", role: .assistant,
                                content: "Transcript of \(scoop.name).",
                                timestamp: 1_756_000_000_000)
                        ]
                    )
                })
            let selected = variant == "scoop" ? threadListResearcher : threadListMainCone
            appState.selectedScoopJid = selected
            appState.leaderActiveScoopJid = threadListDeployCone
            appState.messages = appState.messagesByScoop[selected] ?? []
            return true
        }

        /// Two finished turns on `deploy-bot` (working → idle → working →
        /// awaiting), replacing the roster the way a `scoops.list` does. Run
        /// from the shell's `onAppear`, after the ledger is listening, so the
        /// first roster is its baseline and not news.
        @MainActor
        static func scheduleThreadListTurns(into appState: AppState) {
            guard threadListFixtureVariant != nil else { return }
            let stages: [(String, String?)] = [
                ("idle", nil), ("working", "tool"), ("idle", "awaiting"),
            ]
            Task { @MainActor in
                for (state, activity) in stages {
                    try? await Task.sleep(for: .milliseconds(400))
                    appState.scoops = threadListScoops(
                        deployState: state, deployActivity: activity)
                }
            }
        }

        private static func threadListScoops(
            deployState: String, deployActivity: String?
        ) -> [ScoopSummary] {
            let opus = ScoopSummaryModel(provider: "anthropic", id: "claude-opus-4-6")
            return [
                ScoopSummary(
                    jid: threadListMainCone, name: "cone", folder: "/workspace", isCone: true,
                    assistantLabel: "sliccy", state: "idle", activity: "awaiting", fill: 22,
                    parentId: nil, model: opus),
                ScoopSummary(
                    jid: threadListResearcher, name: "researcher",
                    folder: "/scoops/researcher", isCone: false, assistantLabel: "researcher",
                    state: "working", activity: "tool", fill: 64,
                    parentId: threadListMainCone),
                ScoopSummary(
                    jid: "fixture-scoop-summarizer", name: "summarizer",
                    folder: "/scoops/summarizer", isCone: false, assistantLabel: "summarizer",
                    state: "idle", fill: 8, parentId: threadListResearcher),
                ScoopSummary(
                    jid: "fixture-scoop-reviewer", name: "reviewer", folder: "/scoops/reviewer",
                    isCone: false, assistantLabel: "reviewer", state: "broken", fill: 82,
                    parentId: threadListMainCone),
                ScoopSummary(
                    jid: threadListDeployCone, name: "deploy", folder: "/workspace/deploy",
                    isCone: true, assistantLabel: "deploy-bot", state: deployState,
                    activity: deployActivity, fill: 91, parentId: nil,
                    model: ScoopSummaryModel(provider: "openai", id: "gpt-5")),
                ScoopSummary(
                    jid: "fixture-scoop-tester", name: "tester", folder: "/scoops/tester",
                    isCone: false, assistantLabel: "tester", state: "initializing", fill: nil,
                    parentId: threadListDeployCone),
            ]
        }
    }

    /// A stand-in for `FoundationModelSummarizer`. The line is deliberately
    /// shorter than any fixture preview and carries descenders the preview
    /// lacks, so a row that sizes itself to the string would move. The delay
    /// is paid once: the store summarizes serially, and a per-row sleep would
    /// land the lines several seconds apart.
    private actor ScriptedThreadSummarizer: ThreadSummaryGenerating {
        let delay: Duration
        let line: String
        private var hasSlept = false

        init(delay: Duration, line: String) {
            self.delay = delay
            self.line = line
        }

        func summarize(_ excerpt: String) async -> String? {
            if !hasSlept {
                hasSlept = true
                try? await Task.sleep(for: delay)
            }
            return line
        }
    }
#endif
