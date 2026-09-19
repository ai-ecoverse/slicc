import Foundation
import SliccTrayKit






extension AppState {
    
    
    
    func requestFreshSnapshot() {
        _ = sendToLeader(snapshotRequestForConnection())
    }

    func snapshotRequestForConnection() -> FollowerToLeaderMessage {
        .requestSnapshot(scoopJid: selectedScoopJid)
    }

    
    func selectScoop(jid: String) {
        guard jid != selectedScoopJid else { return }
        guard scoops.contains(where: { $0.jid == jid }) else { return }
        selectedScoopJid = jid
        
        let cached = messagesByScoop[jid] ?? []
        messages = cached
        isStreaming = cached.last?.isStreaming == true
        streamingMessageId = isStreaming ? cached.last?.id : nil
        
        
        
        sendToLeader(.scoopsSelect(scoopJid: jid))
        refreshModels()
    }

    
    var selectedScoop: ScoopSummary? {
        scoops.first(where: { $0.jid == selectedScoopJid })
    }

    
    
    
    
    
    
    var selectedUnitIsReadOnly: Bool {
        selectedScoop?.isReadOnly ?? false
    }

    
    
    
    
    
    var visibleToolUICards: [ToolUIPlaceholder] {
        selectedUnitIsReadOnly ? [] : toolUICards
    }

    var supportsModelControls: Bool {
        (leaderProtocolVersion ?? 0) >= 5
    }

    
    
    
    var supportsTabTeleport: Bool {
        (leaderProtocolVersion ?? 0) >= 6
    }

    
    
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

    
    
    func refreshModels() {
        guard supportsModelControls else { return }
        sendToLeader(.modelsRequest)
    }

    
    
    
    
    func selectModel(_ modelId: String) {
        guard supportsModelControls,
            modelCatalog.contains(where: { $0.modelId == modelId })
        else { return }
        sendToLeader(.modelSelect(modelId: modelId, scoopJid: selectedScoopJid))
    }

    
    
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
