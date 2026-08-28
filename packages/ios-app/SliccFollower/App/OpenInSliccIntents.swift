import AppIntents

/// "Open in Sliccy's Browser" — the App-Review-safe share-sheet route
/// (#1918): a Shortcut carrying this intent appears in Safari's share
/// sheet, receives the page URL, and foregrounds the app. The intent only
/// enqueues into `InboundActionCoordinator`; the shell owns execution.
///
/// ## Why this carries no intent schema
///
/// `browser.createTab` and `browser.openURLInTab` both look like a fit and
/// neither is. The metadata processor enforces their exact shape, and it
/// wants (verified against the iOS 26 SDK):
///
/// - `openURLInTab` — a required `tab` parameter, i.e. load into a tab the
///   user already named. This intent's job is the opposite: a share-sheet tap
///   with no tab in hand.
/// - `createTab` — an optional `url`, a required `isPrivate`, and a
///   `perform()` returning `ReturnsValue<Schema<TabEntity>>`.
///
/// The return is the disqualifying one. This intent deliberately **only
/// enqueues** into `InboundActionCoordinator`; the shell owns execution and
/// creates the tab later (#1918). There is no tab to return at `perform()`
/// time, so conforming would mean fabricating a `TabEntity` for a tab that
/// does not exist — a schema is a promise to Siri about what it is getting
/// back, and a made-up tab id is a lie it would then act on. `isPrivate` has
/// no meaning here either; Sliccy's browser has no private mode.
///
/// So the ENTITY schema is adopted (`SliccTabEntity`, `browser.tab`) and the
/// intent schema is not. Entity schemas make tabs resolvable and indexable
/// with no claim about execution shape; this intent keeps its own contract
/// and stays reachable through Shortcuts, Spotlight and the phrase below.
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

/// "Open Sliccy Conversation" — resolve a cone or scoop by name and bring it
/// up. The counterpart to `SliccConversationEntity`: an entity nothing
/// consumes is inert, and this is the intent that makes one worth indexing.
///
/// `OpenIntent` (hence the parameter named `target`) rather than a bare
/// `AppIntent`, so the system gets the standard "open this thing" treatment —
/// a Spotlight result for a conversation becomes actionable without a
/// Shortcut, and Siri can chain it.
struct OpenSliccConversationIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Sliccy Conversation"
    static let description = IntentDescription(
        "Opens one of Sliccy's conversations.")
    static let openAppWhenRun = true

    @Parameter(title: "Conversation")
    var target: SliccConversationEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        // The user picked this out of a resolved list — explicit enough that
        // no second in-app card is warranted, matching the other intents.
        guard InboundActionCoordinator.shared.receive(selecting: target.id) else {
            throw InboundOpenError.unknownConversation
        }
        return .result()
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
        // `\(.$target)` lets the phrase carry the conversation name, so
        // "Open the deploy conversation in Sliccy" resolves through
        // `SliccConversationQuery` instead of landing on a picker.
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
