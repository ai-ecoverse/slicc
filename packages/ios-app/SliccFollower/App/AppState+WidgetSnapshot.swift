import Foundation
import SliccTrayKit
import SliccWidgetKit

extension AppState {

    func widgetSnapshot(now: Date = Date()) -> WidgetSnapshot {
        let units = scoops.map { $0.widgetUnit(isActive: $0.jid == leaderActiveScoopJid) }
        return WidgetSnapshot(
            instanceLabel: widgetInstanceLabel,
            runtime: nil,
            connection: widgetConnection,
            capturedAt: now,
            units: widgetRecency.stamp(units, now: now),
            lastMessage: widgetLastMessage
        )
    }

    private var widgetInstanceLabel: String {
        let named = activeDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !named.isEmpty { return named }
        if let host = URL(string: joinUrl)?.host, !host.isEmpty { return host }
        return "SLICC"
    }

    private var widgetConnection: WidgetSnapshot.Connection {
        switch settledConnection.state {
        case .connected:
            settledConnection.isStalled ? .stalled : .connected
        case .connecting, .reconnecting, .failed, .gaveUp:
            .disconnected
        case .disconnected:

            hasEverJoinedAnInstance ? .disconnected : WidgetSnapshot.Connection.none
        }
    }

    private var hasEverJoinedAnInstance: Bool {
        !(activeDisplayName ?? "").isEmpty || !joinUrl.isEmpty || trayId != nil
    }

    private var widgetLastMessage: WidgetMessage? {
        guard
            let last = messages.last(where: {
                $0.isStreaming != true && !WidgetMessage.flatten(markdown: $0.content).isEmpty
            })
        else { return nil }
        return WidgetMessage(
            author: last.role == .user ? .user : .agent,
            unitId: last.role == .user ? nil : selectedScoopJid,
            text: WidgetMessage.flatten(markdown: last.content),
            at: Date(timeIntervalSince1970: last.timestamp / 1000)
        )
    }

    func publishWidgetSnapshot() {
        let snapshot = widgetSnapshot()
        widgetPublisher.publish(snapshot)
        Task { await SliccConversationIndexer.shared.donate(snapshot.units) }
    }

    func clearWidgetSnapshot() {
        widgetPublisher.clear()
        Task { await SliccConversationIndexer.shared.donate([]) }
    }
}

extension ScoopSummary {

    func widgetUnit(isActive: Bool) -> WidgetUnit {
        let status = self.status
        return WidgetUnit(
            id: jid,
            name: assistantLabel.isEmpty ? name : assistantLabel,
            role: isRootUnit ? .cone : .scoop,
            parentId: parentId,
            lifecycle: WidgetUnit.Lifecycle(rawValue: status.lifecycle.rawValue) ?? .unknown,
            activity: activity.flatMap(WidgetUnit.Activity.init(rawValue:)),
            fill: status.fullness,
            model: model?.id,
            detail: trigger.map { String(WidgetMessage.flatten(markdown: $0).prefix(120)) },
            isActive: isActive
        )
    }
}
