import AppIntents
import Foundation
import SliccTrayKit









@AppEntity(schema: .browser.tab)
struct SliccTabEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Sliccy Tab")

    static let defaultQuery = SliccTabQuery()

    
    let id: String

    
    
    @Property(title: "Name")
    var name: String

    @Property(title: "URL")
    var url: URL?

    
    
    
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











@MainActor
final class SliccTabRegistry {
    static let shared = SliccTabRegistry()

    private(set) var tabs: [CDPTargetSummary] = []

    func publish(_ tabs: [CDPTargetSummary]) {
        self.tabs = tabs
    }
}



struct SliccTabQuery: EntityQuery, EntityStringQuery {

    
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
