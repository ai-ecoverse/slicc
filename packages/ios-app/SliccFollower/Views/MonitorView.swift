import SwiftUI

/// The dock's `monitor` surface (#1868): the session vitals a follower can
/// honestly report. The web monitor is kernel-backed (processes, cron,
/// webhooks, mounts) — none of that exists on a phone, so this renders
/// what the tray already carries instead of a placeholder: connection
/// health, scoops, session cost summed from message usage, and the
/// follower-hosted surface counts. Anything deeper needs a leader-side
/// summary feed (tracked on the issue).
struct MonitorView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette

    var body: some View {
        List {
            connectionSection
            scoopsSection
            costSection
            surfacesSection
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
    }

    // MARK: Connection

    private var connectionSection: some View {
        Section("Connection") {
            row("State", appState.connectionState.rawValue)
            if appState.isLeaderStalled {
                row("Leader", "stalled — not answering pings")
            }
            if let since = appState.connectedSince {
                row("Connected", since.formatted(date: .omitted, time: .standard))
            }
            row("Participants", "\(appState.participantCount)")
            if appState.reconnectAttempt > 0 {
                row("Reconnect attempt", "\(appState.reconnectAttempt)")
            }
            if let error = appState.leaderError {
                row("Leader error", error)
            }
        }
    }

    // MARK: Scoops

    private var scoopsSection: some View {
        Section("Scoops") {
            if appState.scoops.isEmpty {
                Text("No scoops reported yet")
                    .foregroundStyle(palette.inkSecondary)
            }
            ForEach(appState.scoops) { scoop in
                HStack {
                    ConeScoopGlyph(isCone: scoop.isRootUnit, size: 17)
                        .foregroundStyle(palette.inkSecondary)
                    VStack(alignment: .leading) {
                        Text(scoop.name)
                        if let state = scoop.state {
                            Text(state)
                                .font(.caption)
                                .foregroundStyle(palette.inkSecondary)
                        }
                    }
                    Spacer()
                    if scoop.jid == appState.leaderActiveScoopJid {
                        Text("active")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(palette.accent)
                    }
                }
                .accessibilityIdentifier("monitor-scoop-\(scoop.jid)")
                // On-screen awareness: this row IS a conversation entity, so
                // "summarise that one" can resolve to a jid rather than to
                // whatever text happened to be rendered.
                .sliccEntityAnnotation(SliccConversationEntity.self, id: scoop.jid)
            }
        }
    }

    // MARK: Cost

    /// Sum of the usage the leader attached to assistant turns in the
    /// transcript this follower holds. A snapshot-truncated transcript
    /// undercounts, so it is labeled as visible-session cost, not billing.
    private var visibleCost: (total: Double, turns: Int) {
        var total = 0.0
        var turns = 0
        for message in appState.messages {
            guard let usage = message.usage else { continue }
            total += usage.cost.total
            turns += 1
        }
        return (total, turns)
    }

    private var costSection: some View {
        let cost = visibleCost
        return Section("Session cost (visible transcript)") {
            row("Metered turns", "\(cost.turns)")
            row("Total", String(format: "$%.4f", cost.total))
                .accessibilityIdentifier("monitor-cost-total")
        }
    }

    // MARK: Surfaces

    private var surfacesSection: some View {
        Section("Surfaces") {
            row("Sprinkles", "\(appState.sprinkles.count)")
            row("Browser tabs", "\(appState.cdpTargets.count)")
            row("Messages held", "\(appState.messages.count)")
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value)
                .foregroundStyle(palette.inkSecondary)
                .multilineTextAlignment(.trailing)
        }
    }
}
