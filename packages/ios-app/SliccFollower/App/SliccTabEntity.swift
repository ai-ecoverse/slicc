import AppIntents
import Foundation
import SliccTrayKit

/// One tab in Sliccy's built-in browser, in the shape the `browser.tab` app
/// schema defines (`TabEntity`).
///
/// Unlike `SliccConversationEntity`, this is **not** projected from a
/// persisted snapshot: a tab is live `CDPBridge` state and nothing writes it
/// to disk. A query therefore answers from `SliccTabRegistry`, which is empty
/// while the app is cold — and that is the honest answer, because a tab that
/// only exists in a running WKWebView really is not there yet.
@AppEntity(schema: .browser.tab)
struct SliccTabEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Sliccy Tab")

    static let defaultQuery = SliccTabQuery()

    /// `CDPTargetSummary.id` — the CDP target id the bridge minted.
    let id: String

    /// The schema names this `name`, not `title` — the processor checks the
    /// property name, not just its type.
    @Property(title: "Name")
    var name: String

    @Property(title: "URL")
    var url: URL?

    /// Required by `browser.tab`. Always false, and not a placeholder:
    /// Sliccy's browser has no private mode, so every tab it can describe is
    /// a normal one. Reporting false is the accurate answer, not a stub.
    @Property(title: "Is Private")
    var isPrivate: Bool

    init(id: String, name: String, url: URL?, isPrivate: Bool = false) {
        self.id = id
        self.name = name
        self.url = url
        self.isPrivate = isPrivate
    }

    init(target: CDPTargetSummary) {
        self.init(id: target.id, name: target.title, url: URL(string: target.url))
    }

    /// Title, falling back to the host — an untitled tab is common while a
    /// page is still loading, and "sliccy.ai" beats an empty row.
    ///
    /// A plain `String` rather than only a `DisplayRepresentation`, because
    /// this fallback is the behaviour worth asserting and a
    /// `LocalizedStringResource` has no equatable text to assert against.
    var displayLabel: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty else { return trimmed }
        return url?.host() ?? "Tab"
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(displayLabel)", subtitle: url.map { "\($0.absoluteString)" })
    }
}

// MARK: - Registry

/// The live tab list, reachable from an App Intents query.
///
/// `AppState` is a `@StateObject` owned by the SwiftUI `App` — there is no
/// singleton to reach, and an entity query is not handed one. Rather than
/// grow `AppState` (already at the file-length ceiling) or hand a query an
/// environment it cannot have, the one refresh site publishes here, the same
/// way `InboundActionCoordinator.shared` is the one funnel for inbound
/// actions.
@MainActor
final class SliccTabRegistry {
    static let shared = SliccTabRegistry()

    private(set) var tabs: [CDPTargetSummary] = []

    func publish(_ tabs: [CDPTargetSummary]) {
        self.tabs = tabs
    }
}

// MARK: - Query

struct SliccTabQuery: EntityQuery, EntityStringQuery {

    /// Injected so the rules are testable without a CDP bridge.
    private let tabs: @MainActor () -> [CDPTargetSummary]

    init() {
        self.init(tabs: { SliccTabRegistry.shared.tabs })
    }

    init(tabs: @escaping @MainActor () -> [CDPTargetSummary]) {
        self.tabs = tabs
    }

    @MainActor
    func entities(for identifiers: [String]) async throws -> [SliccTabEntity] {
        let wanted = Set(identifiers)
        return tabs().filter { wanted.contains($0.id) }.map(SliccTabEntity.init(target:))
    }

    @MainActor
    func entities(matching string: String) async throws -> [SliccTabEntity] {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return try await suggestedEntities() }
        return
            tabs()
            .filter {
                $0.title.localizedStandardContains(trimmed)
                    || $0.url.localizedStandardContains(trimmed)
            }
            .map(SliccTabEntity.init(target:))
    }

    @MainActor
    func suggestedEntities() async throws -> [SliccTabEntity] {
        tabs().map(SliccTabEntity.init(target:))
    }
}
