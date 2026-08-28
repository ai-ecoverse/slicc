import AppIntents
import CoreSpotlight
import Foundation
import SliccWidgetKit

/// One SLICC work unit (#1666) as Siri, Spotlight and Shortcuts see it.
///
/// Deliberately projected from the **widget snapshot**, not from `AppState`.
/// An entity query is answered by whatever process the system happens to ask
/// — Spotlight indexing and Siri resolution both run with the app cold — and
/// `AppState` only exists while the UI is up and dialled into a leader. The
/// snapshot is already captured on every transition that matters
/// (`AppState+WidgetSnapshot`), already lives in the shared app group, and is
/// already the app's answer to "describe the session without a connection".
/// Reusing it means Siri and the home screen can never disagree, and adds no
/// second capture path to keep in sync.
struct SliccConversationEntity: AppEntity, IndexedEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Sliccy Conversation")

    static let defaultQuery = SliccConversationQuery()

    /// `ScoopSummary.jid` — stable across reconnects, so an entity Siri
    /// resolved a minute ago still points at the same unit.
    let id: String

    /// The unit's display name. `\.title` is what Spotlight ranks a semantic
    /// match against, so this is the field that makes "my refactor
    /// conversation" resolvable without the user knowing a jid.
    @Property(title: "Name", indexingKey: \.title)
    var name: String

    /// What the unit is for — the prompt or lick that spawned a scoop.
    /// Truncated by the capture side; a snapshot is not a place for a
    /// paragraph.
    @Property(title: "About", indexingKey: \.contentDescription)
    var detail: String?

    /// Bare model id (`claude-opus-4-6` and friends), when the leader said.
    @Property(title: "Model")
    var model: String?

    /// Agent lifecycle, flattened to the widget's closed vocabulary.
    @Property(title: "Status")
    var status: String

    /// Cones are roots the user talks to; scoops are the read-only children
    /// they spawn (`UnitRole.isReadOnly`).
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

// MARK: - Projection

/// Pure snapshot → entity rules.
///
/// Split out of the query for the same reason `BrowserTargets` is split out of
/// the browser surface: the interesting behaviour is ranking and matching, and
/// neither needs an app group, an entitlement or a leader to be tested.
enum SliccConversationProjection {

    /// Cap on what a query hands back. Siri and Spotlight both want a short,
    /// confident list; a leader with a hundred scoops should not turn every
    /// disambiguation prompt into a scroll.
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

    /// Most-useful-first: the unit the leader has focused, then cones (the
    /// ones a user can actually talk to), then whatever changed most
    /// recently, then name so the order is stable when nothing else separates
    /// two units.
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

    /// Case- and diacritic-insensitive substring match over the two fields a
    /// user would actually say out loud. An empty needle matches everything —
    /// "show me my Sliccy conversations" is a listing, not a search.
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

// MARK: - Query

/// Resolves conversation entities for Siri, Spotlight and Shortcuts.
///
/// `EntityStringQuery` is the half that matters for natural language: it lets
/// the system hand us the words the user said ("the deploy one") and get back
/// a unit, with no phrase list to maintain here.
struct SliccConversationQuery: EntityQuery, EntityStringQuery {

    /// Injected so tests can drive the rules without an app-group container.
    /// Production reads the same file the widget does.
    private let units: @Sendable () -> [WidgetUnit]

    /// `EntityQuery` requires a literal `init()`; a defaulted argument does
    /// not satisfy it, so production and the test seam are separate inits.
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

// MARK: - Spotlight donation

/// Pushes the current units into the Spotlight semantic index.
///
/// `IndexedEntity` conformance alone indexes nothing — it only says what an
/// entity would look like if it were indexed. Something has to donate, and the
/// honest moment to do it is the same transition that publishes the widget
/// snapshot, so the index, the widget and Siri all describe one session.
enum SliccConversationIndexer {

    /// Replace the indexed set with `units`.
    ///
    /// Delete-then-index rather than incremental: a scoop that ended should
    /// stop being suggested, and the set is small enough (tens of units) that
    /// diffing it would be more code than it saves. Failures are swallowed on
    /// purpose — an unentitled dev build has no index, and a session that
    /// works is not worth failing over a search affordance.
    static func donate(
        _ units: [WidgetUnit],
        to index: CSSearchableIndex = .default()
    ) async {
        let entities = SliccConversationProjection.entities(
            SliccConversationProjection.ranked(units))
        do {
            try await index.deleteAppEntities(ofType: SliccConversationEntity.self)
            guard !entities.isEmpty else { return }
            try await index.indexAppEntities(entities)
        } catch {
            // Intentionally ignored — see the doc comment.
        }
    }
}
