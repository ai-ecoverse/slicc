import AppIntents
import CoreSpotlight
import Foundation
import SliccWidgetKit












struct SliccConversationEntity: AppEntity, IndexedEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Sliccy Conversation")

    static let defaultQuery = SliccConversationQuery()

    
    
    let id: String

    
    
    
    @Property(title: "Name", indexingKey: \.title)
    var name: String

    
    
    
    @Property(title: "About", indexingKey: \.contentDescription)
    var detail: String?

    
    @Property(title: "Model")
    var model: String?

    
    @Property(title: "Status")
    var status: String

    
    
    @Property(title: "Is Cone")
    var isCone: Bool

    init(
        id: String, name: String, detail: String?, model: String?, status: String, isCone: Bool
    ) {
        self.id = id
        self.name = name
        self.detail = detail
        self.model = model
        self.status = status
        self.isCone = isCone
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(name)",
            subtitle: detail.map { "\($0)" } ?? "\(isCone ? "Cone" : "Scoop")")
    }
}








enum SliccConversationProjection {

    
    
    
    static let maximumResults = 25

    static func entity(from unit: WidgetUnit) -> SliccConversationEntity {
        SliccConversationEntity(
            id: unit.id,
            name: unit.name,
            detail: unit.detail,
            model: unit.model,
            status: unit.lifecycle.rawValue,
            isCone: unit.role == .cone)
    }

    
    
    
    
    static func ranked(_ units: [WidgetUnit]) -> [WidgetUnit] {
        units.sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive { return lhs.isActive }
            if (lhs.role == .cone) != (rhs.role == .cone) { return lhs.role == .cone }
            let left = lhs.lastActivityAt ?? .distantPast
            let right = rhs.lastActivityAt ?? .distantPast
            if left != right { return left > right }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    
    
    
    static func matching(_ needle: String, in units: [WidgetUnit]) -> [WidgetUnit] {
        let trimmed = needle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return ranked(units) }
        return ranked(
            units.filter { unit in
                unit.name.localizedStandardContains(trimmed)
                    || unit.detail?.localizedStandardContains(trimmed) == true
            })
    }

    static func entities(_ units: [WidgetUnit]) -> [SliccConversationEntity] {
        units.prefix(maximumResults).map(entity(from:))
    }
}








struct SliccConversationQuery: EntityQuery, EntityStringQuery {

    
    
    private let units: @Sendable () -> [WidgetUnit]

    
    
    init() {
        self.init(units: { WidgetHost.follower.store.read()?.units ?? [] })
    }

    init(units: @escaping @Sendable () -> [WidgetUnit]) {
        self.units = units
    }

    func entities(for identifiers: [String]) async throws -> [SliccConversationEntity] {
        let wanted = Set(identifiers)
        return SliccConversationProjection.entities(
            SliccConversationProjection.ranked(units().filter { wanted.contains($0.id) }))
    }

    func entities(matching string: String) async throws -> [SliccConversationEntity] {
        SliccConversationProjection.entities(
            SliccConversationProjection.matching(string, in: units()))
    }

    func suggestedEntities() async throws -> [SliccConversationEntity] {
        SliccConversationProjection.entities(SliccConversationProjection.ranked(units()))
    }
}






protocol SpotlightConversationIndex: Sendable {
    func deleteConversations() async throws
    func indexConversations(_ entities: [SliccConversationEntity]) async throws
}


struct SystemSpotlightIndex: SpotlightConversationIndex {
    func deleteConversations() async throws {
        try await CSSearchableIndex.default().deleteAppEntities(
            ofType: SliccConversationEntity.self)
    }

    func indexConversations(_ entities: [SliccConversationEntity]) async throws {
        try await CSSearchableIndex.default().indexAppEntities(entities)
    }
}























actor SliccConversationIndexer {

    static let shared = SliccConversationIndexer()

    private let index: any SpotlightConversationIndex
    private var latestGeneration = 0
    private var tail: Task<Void, Never>?

    init(index: any SpotlightConversationIndex = SystemSpotlightIndex()) {
        self.index = index
    }

    
    
    @discardableResult
    func donate(_ units: [WidgetUnit]) -> Task<Void, Never> {
        latestGeneration += 1
        let generation = latestGeneration
        let entities = SliccConversationProjection.entities(
            SliccConversationProjection.ranked(units))
        let previous = tail
        let task = Task { [self] in
            await previous?.value
            await perform(entities, generation: generation)
        }
        tail = task
        return task
    }

    private func perform(_ entities: [SliccConversationEntity], generation: Int) async {
        guard generation == latestGeneration else { return }
        do {
            try await index.deleteConversations()
            guard !entities.isEmpty else { return }
            try await index.indexConversations(entities)
        } catch {
            
            
        }
    }
}
