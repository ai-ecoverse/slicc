import AppIntents

/// "Open in Sliccy's Browser" — the App-Review-safe share-sheet route
/// (#1918): a Shortcut carrying this intent appears in Safari's share
/// sheet, receives the page URL, and foregrounds the app. The intent only
/// enqueues into `InboundActionCoordinator`; the shell owns execution.
struct OpenInSliccBrowserIntent: AppIntent {
    static let title: LocalizedStringResource = "Open in Sliccy's Browser"
    static let description = IntentDescription(
        "Opens a web page as a local tab in Sliccy's browser.")
    static let openAppWhenRun = true

    @Parameter(title: "URL") var url: URL

    @MainActor
    func perform() async throws -> some IntentResult {
        // The user just invoked this intent by hand — that is the explicit
        // action, so no second in-app confirmation is required.
        guard InboundActionCoordinator.shared.receive(url: url, needsConfirmation: false) else {
            throw InboundOpenError.invalidURL
        }
        return .result()
    }
}

enum InboundOpenError: Error, CustomLocalizedStringResourceConvertible {
    case invalidURL

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .invalidURL:
            return "Sliccy can only open http(s) web addresses without embedded credentials."
        }
    }
}

/// "Prompt Sliccy" — sends a prompt to the connected leader and returns the
/// completed reply as an intent value, so it can feed the next Shortcut
/// action (#1918). Invoking the intent is the explicit user action; the
/// shell executes without a second card and the intent awaits settlement.
struct PromptSliccIntent: AppIntent {
    static let title: LocalizedStringResource = "Prompt Sliccy"
    static let description = IntentDescription(
        "Sends a prompt to the connected Sliccy leader and returns the completed reply.")
    static let openAppWhenRun = true

    @Parameter(title: "Prompt") var prompt: String

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let reply = try await InboundActionCoordinator.shared.runIntentPrompt(prompt)
        return .result(value: reply)
    }
}

/// "Get Current Sliccy Conversation" — returns the selected conversation as
/// a bounded Markdown file after a fresh leader snapshot (#1918). Exports
/// exactly what the phone renders on screen; nothing is logged.
struct GetSliccConversationIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Current Sliccy Conversation"
    static let description = IntentDescription(
        "Returns the currently selected Sliccy conversation as a Markdown file.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<IntentFile> {
        let markdown = try await InboundActionCoordinator.shared.runTranscriptRequest()
        let file = IntentFile(
            data: Data(markdown.utf8), filename: "slicc-conversation.md",
            type: .plainText)
        return .result(value: file)
    }
}

struct SliccAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenInSliccBrowserIntent(),
            phrases: ["Open in \(.applicationName)"],
            shortTitle: "Open in Browser",
            systemImageName: "globe")
        AppShortcut(
            intent: PromptSliccIntent(),
            phrases: ["Prompt \(.applicationName)"],
            shortTitle: "Prompt",
            systemImageName: "text.bubble")
        AppShortcut(
            intent: GetSliccConversationIntent(),
            phrases: ["Get \(.applicationName) conversation"],
            shortTitle: "Get Conversation",
            systemImageName: "doc.text")
    }
}
