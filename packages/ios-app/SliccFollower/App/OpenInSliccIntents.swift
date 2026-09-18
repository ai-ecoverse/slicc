import AppIntents






























struct OpenInSliccBrowserIntent: AppIntent {
    static let title: LocalizedStringResource = "Open in Sliccy's Browser"
    static let description = IntentDescription(
        "Opens a web page as a local tab in Sliccy's browser.")
    static let openAppWhenRun = true

    @Parameter(title: "URL") var url: URL

    @MainActor
    func perform() async throws -> some IntentResult {
        
        
        guard InboundActionCoordinator.shared.receive(url: url, needsConfirmation: false) else {
            throw InboundOpenError.invalidURL
        }
        return .result()
    }
}

enum InboundOpenError: Error, CustomLocalizedStringResourceConvertible {
    case invalidURL
    case unknownConversation

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .invalidURL:
            return "Sliccy can only open http(s) web addresses without embedded credentials."
        case .unknownConversation:
            return "That conversation is not in this Sliccy session any more."
        }
    }
}









struct OpenSliccConversationIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Sliccy Conversation"
    static let description = IntentDescription(
        "Opens one of Sliccy's conversations.")
    static let openAppWhenRun = true

    @Parameter(title: "Conversation")
    var target: SliccConversationEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        
        
        guard InboundActionCoordinator.shared.receive(selecting: target.id) else {
            throw InboundOpenError.unknownConversation
        }
        return .result()
    }
}





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
        
        
        
        AppShortcut(
            intent: OpenSliccConversationIntent(),
            phrases: [
                "Open \(\.$target) in \(.applicationName)",
                "Open \(.applicationName) conversation \(\.$target)",
            ],
            shortTitle: "Open Conversation",
            systemImageName: "bubble.left.and.bubble.right")
    }
}
