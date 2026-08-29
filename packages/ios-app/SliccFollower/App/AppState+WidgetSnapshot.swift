import Foundation
import SliccTrayKit
import SliccWidgetKit

/// The follower's half of the widget contract: turn the state this app already
/// holds into the small, honest description the widget renders.
///
/// A widget cannot dial a leader, so everything it will ever show has to be
/// captured here, on the transitions below. Nothing else in the app knows the
/// widget exists.
extension AppState {
    /// Snapshot the session as it stands.
    ///
    /// `now` is a parameter so a test can pin the recency stamps the ledger
    /// writes; production passes the wall clock.
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

    /// What to call the instance. The label the user gave the session, else
    /// the host they joined — never the join URL, which is a secret.
    private var widgetInstanceLabel: String {
        let named = activeDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !named.isEmpty { return named }
        if let host = URL(string: joinUrl)?.host, !host.isEmpty { return host }
        return "SLICC"
    }

    /// The app's connection vocabulary, narrowed to what a widget can act on.
    ///
    /// Reads the SETTLED health, not the raw state: the app deliberately holds
    /// a blip for `ConnectionSettler.holdDuration` before showing trouble, and
    /// a widget that flaps to "not connected" during a reconnect the user
    /// never saw would be worse than one that lags by a second.
    private var widgetConnection: WidgetSnapshot.Connection {
        switch settledConnection.state {
        case .connected:
            settledConnection.isStalled ? .stalled : .connected
        case .connecting, .reconnecting, .failed, .gaveUp:
            .disconnected
        case .disconnected:
            // "No instance" and "an instance you are not attached to right
            // now" are different states with different copy, and the only
            // thing separating them is whether this device has ever joined.
            // Spelled out: a bare `.none` in a ternary resolves to
            // `Optional.none`, not to this enum's case.
            hasEverJoinedAnInstance ? .disconnected : WidgetSnapshot.Connection.none
        }
    }

    /// Whether this device has ever attached to an instance. Distinguishes
    /// the widget's "No instance" from its "Not connected".
    private var hasEverJoinedAnInstance: Bool {
        !(activeDisplayName ?? "").isEmpty || !joinUrl.isEmpty || trayId != nil
    }

    /// The most recent turn in the transcript this follower holds, flattened
    /// to plain text. A streaming turn is skipped — half a sentence on a home
    /// screen reads as a bug, and the turn-end publish is a moment away.
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

    /// Capture and hand to the publisher. Cheap enough to call from any of the
    /// transitions that matter; the publisher decides whether it reaches disk.
    ///
    /// The same units also go to the Spotlight semantic index, so Siri,
    /// Spotlight and the home screen describe one session rather than three
    /// vintages of one. Indexing is detached: it talks to a system service,
    /// and a publish must not wait on it.
    func publishWidgetSnapshot() {
        let snapshot = widgetSnapshot()
        widgetPublisher.publish(snapshot)
        Task { await SliccConversationIndexer.shared.donate(snapshot.units) }
    }

    /// Forget the instance. A detached session must not linger on a home
    /// screen with a name the user has already walked away from — nor in
    /// Spotlight, where a stale hit would offer to open a conversation that
    /// this device can no longer reach.
    func clearWidgetSnapshot() {
        widgetPublisher.clear()
        Task { await SliccConversationIndexer.shared.donate([]) }
    }
}

extension ScoopSummary {
    /// The widget's projection of one work unit. Deliberately lossy: the
    /// folder, the trigger's full text and the provider half of the model all
    /// stay behind.
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
