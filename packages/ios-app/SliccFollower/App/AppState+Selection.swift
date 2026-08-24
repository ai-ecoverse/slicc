import Foundation
import SliccTrayKit

// MARK: - Scoop / Model / Thinking Selection

// Lives outside the `AppState` body, which sits against the SwiftLint
// `file_length` ceiling — the same reason `AppState+ScoopSwipe` does.

extension AppState {
    /// Snapshot request sent on every fresh data channel, preserving the viewed scoop.
    /// Re-request the selected scoop's snapshot (transcript export wants
    /// fresh rows, not the in-memory mirror; #1918).
    func requestFreshSnapshot() {
        _ = sendToLeader(snapshotRequestForConnection())
    }

    func snapshotRequestForConnection() -> FollowerToLeaderMessage {
        .requestSnapshot(scoopJid: selectedScoopJid)
    }

    /// The summary for the currently-viewed scoop, if any.
    var selectedScoop: ScoopSummary? {
        scoops.first(where: { $0.jid == selectedScoopJid })
    }

    /// Whether the selected unit renders read-only (#2367): a scoop is the
    /// cone's work, not a conversation of its own. The rule itself lives in
    /// `UnitRole.isReadOnly` — this is only where the SELECTION reaches it.
    /// A selection the roster does not describe yet keeps the composer: that
    /// is the pre-multiple-cones default, and the next `scoops.list`
    /// re-asserts it (the browser follower resolves it the same way).
    var selectedUnitIsReadOnly: Bool {
        selectedScoop?.isReadOnly ?? false
    }

    var supportsModelControls: Bool {
        (leaderProtocolVersion ?? 0) >= 5
    }

    /// Whether the leader understands `tab.teleport.request` (protocol v6):
    /// a tray tab opened here carrying its cookies + web storage, rather than
    /// the bare-URL copy an older leader can offer.
    var supportsTabTeleport: Bool {
        (leaderProtocolVersion ?? 0) >= 6
    }

    /// Ask the leader to teleport a tray tab here. The reply arrives as
    /// `tab.opened`, which surfaces the new tab through `leaderOpenedTabId`.
    func requestTabTeleport(targetId: String) -> Bool {
        sendToLeader(
            .tabTeleportRequest(
                requestId: "tab-teleport-\(UUID().uuidString)", targetId: targetId))
    }

    var activeModel: TrayModelCatalogEntry? {
        guard let activeModelId = modelSelectionState?.activeModelId else { return nil }
        return modelCatalog.first(where: { $0.modelId == activeModelId })
    }

    var displayedThinkingLevel: String {
        guard modelSelectionState?.scoopJid == selectedScoopJid else { return "off" }
        if modelSelectionState?.effortOverride == "max" { return "max" }
        switch modelSelectionState?.thinkingLevel {
        case .minimal: return "low"
        case .off, nil: return "off"
        case .low: return "low"
        case .medium: return "medium"
        case .high: return "high"
        case .xhigh: return "xhigh"
        }
    }

    /// Refresh the credential-free catalog and current selection state. Legacy
    /// leaders never see this additive v5 request.
    func refreshModels() {
        guard supportsModelControls else { return }
        sendToLeader(.modelsRequest)
    }

    /// Ask the leader to change the model of the cone this follower is
    /// looking at (#2310) — model selection is per cone, so the selected unit
    /// travels with the pick. Only advertised catalog ids are accepted,
    /// preventing arbitrary provider/account data from reaching the wire.
    func selectModel(_ modelId: String) {
        guard supportsModelControls,
            modelCatalog.contains(where: { $0.modelId == modelId })
        else { return }
        sendToLeader(.modelSelect(modelId: modelId, scoopJid: selectedScoopJid))
    }

    /// Map the Settings control's browser-compatible scale onto the wire. The
    /// UI-only `max` value is encoded as xhigh + effortOverride max.
    func setThinkingLevel(_ displayLevel: String) {
        guard supportsModelControls, activeModel?.reasoning == true,
            let scoopJid = selectedScoopJid,
            let wireValue = Self.thinkingWireValue(for: displayLevel)
        else { return }
        sendToLeader(
            .thinkingSet(
                scoopJid: scoopJid, thinkingLevel: wireValue.level,
                effortOverride: wireValue.effortOverride))
    }

    static func thinkingWireValue(
        for displayLevel: String
    ) -> (level: TrayThinkingLevel, effortOverride: String?)? {
        if displayLevel == "max" { return (.xhigh, "max") }
        guard let level = TrayThinkingLevel(rawValue: displayLevel) else { return nil }
        return (level, nil)
    }
}
