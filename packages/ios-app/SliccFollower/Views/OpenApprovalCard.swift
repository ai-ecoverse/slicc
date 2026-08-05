import SliccTrayKit
import SwiftUI

/// Native, interactive approval surface for the iOS-only `open` exec grammar.
/// It receives the parsed safe-display fields, never the URL query or fragment.
struct OpenApprovalCard: View {
    let request: OpenApprovalRequest
    let onDecision: (OpenApprovalDecision) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Open another app?", systemImage: "arrow.up.forward.app")
                .font(.headline)
            detail("Requester", request.requesterIdentity)
            detail("Session", request.sessionIdentity)
            detail("Scheme", request.command.displayScheme)
            detail("Destination", request.command.displayHostAction)
            detail("Returns data", request.command.returnsResultData ? "Yes" : "No")
            HStack {
                Button("Deny", role: .destructive) { onDecision(.deny) }
                    .accessibilityIdentifier("open-approval-deny")
                Spacer()
                Button("Allow once") { onDecision(.allowOnce) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("open-approval-once")
                Button("Always allow") { onDecision(.alwaysAllow) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("open-approval-always")
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(palette.ink.opacity(0.12), lineWidth: 0.5)
        )
        .padding(.horizontal, 4)
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(palette.ink.opacity(0.55))
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
                .foregroundStyle(palette.ink.opacity(0.85))
        }
        .font(.subheadline)
    }
}
