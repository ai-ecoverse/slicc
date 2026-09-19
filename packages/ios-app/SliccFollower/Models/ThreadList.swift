import CoreGraphics
import Foundation
import SliccTrayKit





struct ThreadListEntry: Equatable, Identifiable {
    let scoop: ScoopSummary
    let depth: Int

    var id: String { scoop.jid }
}














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






struct ThreadListRow: Equatable, Identifiable {
    let jid: String
    
    let label: String
    let role: UnitRole
    let depth: Int
    let status: ScoopStatus
    
    let activity: AvatarExpression.Activity?
    let isSelected: Bool
    
    let isLeaderActive: Bool
    
    
    let unread: Int
    
    let modelId: String?
    
    let scoop: ScoopSummary

    var id: String { jid }
    var isReadOnly: Bool { role.isReadOnly }

    
    var activityPhrase: String? {
        switch status.lifecycle {
        case .working: activity == .working ? "running a tool" : "thinking"
        case .idle: activity == .awaiting ? "waiting for you" : "idle"
        case .broken: "broken"
        case .initializing: "starting"
        case .unknown: nil
        }
    }

    
    
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
    
    init(_ scoop: ScoopSummary) {
        self.init(
            id: scoop.jid, isRoot: scoop.isRootUnit, lifecycle: scoop.status.lifecycle,
            turns: nil)
    }
}





enum ThreadListPresentation: Equatable, Sendable {
    case overlay
    case sidebar
}






enum ThreadListLayout {
    static let sidebarWidth: CGFloat = 280

    
    
    static func dismissGlyph(_ presentation: ThreadListPresentation, onTrailingEdge: Bool) -> String {
        guard presentation == .sidebar else { return "xmark" }
        return onTrailingEdge ? "sidebar.right" : "sidebar.left"
    }
    static let overlayMaxWidth: CGFloat = 320
    
    static let railWidth: CGFloat = 48
    
    static let minConversationWidth: CGFloat = 400
    
    
    static let minSplitColumnWidth: CGFloat = 320

    static func presentation(
        shellMode: ShellLayoutMode,
        availableWidth: CGFloat,
        workbenchOpen: Bool
    ) -> ThreadListPresentation {
        guard shellMode == .regularSplit else { return .overlay }
        
        
        let remaining = availableWidth - railWidth - sidebarWidth
        let needed = workbenchOpen ? minSplitColumnWidth * 2 : minConversationWidth
        return remaining >= needed ? .sidebar : .overlay
    }

    
    
    static func overlayWidth(availableWidth: CGFloat) -> CGFloat {
        max(0, min(overlayMaxWidth, availableWidth - 56))
    }
}
