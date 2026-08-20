import SliccTrayKit
import SwiftUI

/// Native approval surface for a delegated sudo prompt (#2062). Allow and
/// Always go through Face ID / passcode in the controller; Deny never does.
/// "Always" exposes the editable pattern so the human can narrow or widen the
/// grant before it becomes a `NOPASSWD` rule on the leader.
struct SudoApprovalCard: View {
    let request: SudoApprovalRequest
    /// Whether this device can authenticate its owner. Without it the leader
    /// would downgrade "Always" anyway, so the button is not offered.
    let allowAlways: Bool
    let onDecision: (SudoApprovalDecision) -> Void

    @Environment(\.palette) private var palette
    @State private var pattern: String = ""
    @State private var showsPattern = false
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(request.heading, systemImage: "key.fill")
                .font(.headline)
            if let scoop = request.scoopName {
                detail("Requested by", scoop)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(request.detailLabel)
                    .foregroundStyle(palette.ink.opacity(0.55))
                Spacer()
                Text(request.displayDetail)
                    .font(request.kind == "export" ? .subheadline : .system(.subheadline, design: .monospaced))
                    .multilineTextAlignment(.trailing)
                    .foregroundStyle(palette.ink.opacity(0.85))
                    .textSelection(.enabled)
            }
            .font(.subheadline)
            if showsPattern {
                TextField("Always allow pattern", text: $pattern)
                    .font(.system(.subheadline, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(8)
                    .background(palette.ink.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("sudo-approval-pattern")
            }
            Text(
                request.kind == "export"
                    ? "A complete copy of the transcript leaves the session. Face ID confirms it is you."
                    : "Face ID confirms it is you before anything runs. Deny needs nothing."
            )
            .font(.footnote)
            .foregroundStyle(palette.ink.opacity(0.55))
            HStack {
                Button("Deny", role: .destructive) { decide(.deny) }
                    .accessibilityIdentifier("sudo-approval-deny")
                Spacer()
                if allowAlways {
                    Button(showsPattern ? "Always allow" : "Always…") {
                        if showsPattern {
                            decide(.always(pattern: pattern))
                        } else {
                            pattern = request.defaultPattern
                            withAnimation { showsPattern = true }
                        }
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("sudo-approval-always")
                }
                Button("Allow once") { decide(.allowOnce) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("sudo-approval-once")
            }
            .disabled(busy)
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
        .accessibilityIdentifier("sudo-approval-card")
    }

    private func decide(_ decision: SudoApprovalDecision) {
        busy = true
        onDecision(decision)
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
