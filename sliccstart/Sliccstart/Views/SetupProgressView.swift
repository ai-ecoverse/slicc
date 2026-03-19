import SwiftUI

struct SetupProgressView: View {
    let message: String
    let isWorking: Bool
    let error: String?
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            if isWorking {
                ProgressView()
                    .controlSize(.large)
            }
            Text(message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if error != nil {
                Button("Retry") { onRetry() }
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}
