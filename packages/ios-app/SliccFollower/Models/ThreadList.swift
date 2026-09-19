import CoreGraphics
import Foundation
import SliccTrayKit

// MARK: - Ordering

/// One unit placed in the thread list: the summary plus how deep it sits
/// under the cone that owns it.
struct ThreadListEntry: Equatable, Identifiable {
    let scoop: ScoopSummary
    let depth: Int

    var id: String { scoop.jid }
}

/// The thread list's order — the webapp's `orderUnits` / `orderRoots`
/// (`work-unit/client/presentation.ts`), nested instead of flat.
///
/// The web strip is one row, so it hoists every cone to the front and then
/// lists the scoops. A column can nest, so each cone is followed by its own
/// scoops — depth-first, in leader order, exactly the order the strip gives
/// that cone's scoops. Cones keep the strip's order. Units whose owner is
/// unknown (a leader too old to send `parentId`, or a broken chain) trail in
/// leader order, as they do on the web.
///
/// `ScoopSummary.parentId` cannot tell "root" from "absent" (both decode to
/// `nil`), but no case needs it: an absent edge on a non-root never matches an
/// owner, so it lands in the tail — the web's legacy branch, reached for free.
enum ThreadListOrder {
    static func entries(
        _ scoops: [ScoopSummary],
        addedAt: (ScoopSummary) -> String? = { _ in nil }
    ) -> [ThreadListEntry] {
        let roots = orderRoots(scoops.filter(\.isRootUnit), addedAt: addedAt)
        var placed = Set(roots.map(\.jid))
        var out: [ThreadListEntry] = []
        for root in roots {
            out.append(ThreadListEntry(scoop: root, depth: 0))
            appendDescendants(of: root.jid, depth: 1, in: scoops, placed: &placed, out: &out)
        }
        for scoop in scoops where !placed.contains(scoop.jid) {
            out.append(ThreadListEntry(scoop: scoop, depth: scoop.isRootUnit ? 0 : 1))
        }
        return out
    }

    /// Roots oldest first when EVERY root carries a timestamp, else in leader
    /// order — sorting a partial set would interleave a real order with a
    /// positional one. Ties break on jid, as on the web.
    ///
    /// `addedAt` is not mirrored into `ScoopSummary` yet (the corpus pins it as
    /// dropped), so the app passes nothing and leader order stands — which is
    /// what the web does for a leader that omits it.
    static func orderRoots(
        _ roots: [ScoopSummary],
        addedAt: (ScoopSummary) -> String? = { _ in nil }
    ) -> [ScoopSummary] {
        guard roots.count > 1 else { return roots }
        let stamps = roots.map(addedAt)
        guard stamps.allSatisfy({ ($0 ?? "").isEmpty == false }) else { return roots }
        return zip(roots, stamps)
            .sorted { lhs, rhs in
                let left = lhs.1 ?? ""
                let right = rhs.1 ?? ""
                return left == right ? lhs.0.jid < rhs.0.jid : left < right
            }
            .map(\.0)
    }

    /// Depth-first, skipping anything already placed — which is also what
    /// stops a cyclic chain from a corrupt record or a hostile wire.
    private static func appendDescendants(
        of ownerJid: String, depth: Int, in scoops: [ScoopSummary],
        placed: inout Set<String>, out: inout [ThreadListEntry]
    ) {
        for scoop in scoops where scoop.parentId == ownerJid && !placed.contains(scoop.jid) {
            placed.insert(scoop.jid)
            out.append(ThreadListEntry(scoop: scoop, depth: depth))
            appendDescendants(
                of: scoop.jid, depth: depth + 1, in: scoops, placed: &placed, out: &out)
        }
    }
}

// MARK: - Row markers

/// Everything one thread-list row shows, derived once from the roster. A plain
/// value: no closures ride on it, so a roster push that changes nothing
/// visible compares equal and re-renders nothing.
struct ThreadListRow: Equatable, Identifiable {
    let jid: String
    /// The web tab's label: the assistant label for a cone, the name for a scoop.
    let label: String
    let role: UnitRole
    let depth: Int
    let status: ScoopStatus
    /// The expression channel the row's avatar wears (and the phase it spells).
    let activity: AvatarExpression.Activity?
    let isSelected: Bool
    /// The unit the leader itself is showing.
    let isLeaderActive: Bool
    /// Turns this cone finished while you were elsewhere. Zero for a scoop and
    /// for the selected unit (selection is the read receipt).
    let unread: Int
    /// The unit's own model id, when the leader sends one (#2310).
    let modelId: String?
    /// The summary the avatar geometry is drawn from.
    let scoop: ScoopSummary

    var id: String { jid }
    var isReadOnly: Bool { role.isReadOnly }

    /// What the unit is doing, in the words the web tab's aria-label uses.
    var activityPhrase: String? {
        switch status.lifecycle {
        case .working: activity == .working ? "running a tool" : "thinking"
        case .idle: activity == .awaiting ? "waiting for you" : "idle"
        case .broken: "broken"
        case .initializing: "starting"
        case .unknown: nil
        }
    }

    /// The fill the row prints beside the phase — the pupils already carry it,
    /// the number is for reading at a glance.
    var fillText: String? {
        status.fullness.map { "\(Int($0.rounded()))%" }
    }

    var accessibilityLabel: String {
        var parts = [status.accessibilityPhrase(label: label)]
        if let activityPhrase, status.lifecycle == .working || activity == .awaiting {
            parts.append(activityPhrase)
        }
        parts.append(role.rawValue)
        if isLeaderActive { parts.append("active on leader") }
        if isReadOnly { parts.append("read-only") }
        if unread > 0 { parts.append("\(unread) unread \(unread == 1 ? "turn" : "turns")") }
        if let modelId { parts.append(modelId) }
        return parts.joined(separator: " · ")
    }

    /// Build the rows in thread-list order. `local` is the follower's own
    /// signals for the selected unit, the same precedence the header avatar
    /// uses (`ScoopSummary.avatarActivity`).
    static func rows(
        scoops: [ScoopSummary],
        selectedJid: String?,
        leaderActiveJid: String?,
        unread: [String: Int],
        local: ScoopSummary.LocalExpressionSignals? = nil
    ) -> [ThreadListRow] {
        ThreadListOrder.entries(scoops).map { entry in
            let scoop = entry.scoop
            let selected = scoop.jid == selectedJid
            return ThreadListRow(
                jid: scoop.jid,
                label: scoop.isRootUnit ? scoop.assistantLabel : scoop.name,
                role: scoop.role,
                depth: entry.depth,
                status: scoop.status,
                activity: scoop.avatarActivity(local: selected ? local : nil),
                isSelected: selected,
                isLeaderActive: scoop.jid == leaderActiveJid,
                unread: scoop.isRootUnit && !selected ? max(0, unread[scoop.jid] ?? 0) : 0,
                modelId: scoop.model?.id,
                scoop: scoop)
        }
    }
}

// MARK: - Unread ledger

/// The follower's port of the webapp `UnreadLedger` (`work-unit/client/
/// unread.ts`): cones only, selection is the read receipt, first sightings are
/// never news, a counter that goes down is a reloaded leader.
///
/// The web prefers the `turns` counter and falls back to watching `state`
/// leave `working`. `ScoopSummary.turns` is not mirrored into Swift yet, so
/// the app feeds `turns: nil` and runs the fallback — the branch the web runs
/// for any leader that omits the counter. Both branches are here so mirroring
/// the field is a one-line change at the call site.
struct ThreadUnreadLedger {
    struct Unit: Equatable {
        let id: String
        let isRoot: Bool
        let lifecycle: ScoopLifecycle
        let turns: Int?
    }

    private var counts: [String: Int] = [:]
    private var lastState: [String: ScoopLifecycle] = [:]
    private var lastTurns: [String: Int] = [:]

    mutating func sync(_ units: [Unit], selectedId: String?) -> [String: Int] {
        var present = Set<String>()
        for unit in units where unit.isRoot {
            present.insert(unit.id)
            let finished = turnsFinished(unit)
            if finished > 0, unit.id != selectedId {
                counts[unit.id, default: 0] += finished
            }
        }
        if let selectedId { counts[selectedId] = nil }
        counts = counts.filter { present.contains($0.key) }
        lastState = lastState.filter { present.contains($0.key) }
        lastTurns = lastTurns.filter { present.contains($0.key) }
        return counts
    }

    private mutating func turnsFinished(_ unit: Unit) -> Int {
        let previousState = lastState[unit.id]
        let seen = previousState != nil
        lastState[unit.id] = unit.lifecycle
        if let turns = unit.turns {
            let previousTurns = lastTurns[unit.id] ?? (seen ? 0 : nil)
            lastTurns[unit.id] = turns
            guard let previousTurns else { return 0 }
            return turns > previousTurns ? turns - previousTurns : 0
        }
        lastTurns[unit.id] = nil
        return seen && previousState == .working && unit.lifecycle != .working ? 1 : 0
    }
}

extension ThreadUnreadLedger.Unit {
    /// `turns: nil` until `ScoopSummary.turns` is mirrored (see the ledger).
    init(_ scoop: ScoopSummary) {
        self.init(
            id: scoop.jid, isRoot: scoop.isRootUnit, lifecycle: scoop.status.lifecycle,
            turns: nil)
    }
}

// MARK: - Layout

/// How the thread list presents: a slide-over panel above the conversation,
/// or a persistent column beside it — `NavigationSplitView`'s two shapes.
enum ThreadListPresentation: Equatable, Sendable {
    case overlay
    case sidebar
}

/// Pure presentation choice. Driven ONLY by the shell mode (size class +
/// width) and the width actually available — never device idiom, the screen,
/// or interface orientation. A foldable's inner display is an iPhone idiom
/// with a regular size class in both orientations, and a side-by-side app
/// shrinks the width under us; both land on the right shape here.
enum ThreadListLayout {
    static let sidebarWidth: CGFloat = 280

    /// The header's dismiss control: a sidebar folds toward the edge it sits
    /// on (trailing under `leftHandedDock`); a slide-over closes.
    static func dismissGlyph(_ presentation: ThreadListPresentation, onTrailingEdge: Bool) -> String {
        guard presentation == .sidebar else { return "xmark" }
        return onTrailingEdge ? "sidebar.right" : "sidebar.left"
    }
    static let overlayMaxWidth: CGFloat = 320
    /// The dock rail's fixed width (`DockRail`).
    static let railWidth: CGFloat = 48
    /// Narrowest the conversation may get beside the sidebar on its own.
    static let minConversationWidth: CGFloat = 400
    /// Narrowest each of conversation and workbench may get when both show;
    /// the regular shell splits them evenly.
    static let minSplitColumnWidth: CGFloat = 320

    static func presentation(
        shellMode: ShellLayoutMode,
        availableWidth: CGFloat,
        workbenchOpen: Bool
    ) -> ThreadListPresentation {
        guard shellMode == .regularSplit else { return .overlay }
        // Where the iOS 27.1 SDK's `ReservedRegion` (a foldable's hinge) would
        // be subtracted from the width before this budget is taken.
        let remaining = availableWidth - railWidth - sidebarWidth
        let needed = workbenchOpen ? minSplitColumnWidth * 2 : minConversationWidth
        return remaining >= needed ? .sidebar : .overlay
    }

    /// A slide-over never covers the whole window: a strip of the conversation
    /// stays visible to tap back to.
    static func overlayWidth(availableWidth: CGFloat) -> CGFloat {
        max(0, min(overlayMaxWidth, availableWidth - 56))
    }
}
