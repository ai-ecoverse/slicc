import AppIntents

/// "Open in SLICC's Browser" — the App-Review-safe share-sheet route
/// (#1918): a Shortcut carrying this intent appears in Safari's share
/// sheet, receives the page URL, and foregrounds the app. The intent only
/// enqueues into `InboundActionCoordinator`; the shell owns execution.
struct OpenInSliccBrowserIntent: AppIntent {
    static let title: LocalizedStringResource = "Open in SLICC's Browser"
    static let description = IntentDescription(
        "Opens a web page as a local tab in SLICC's browser.")
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
            return "SLICC can only open http(s) web addresses without embedded credentials."
        }
    }
}

struct SliccAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenInSliccBrowserIntent(),
            phrases: ["Open in \(.applicationName)"],
            shortTitle: "Open in Browser",
            systemImageName: "globe")
    }
}
