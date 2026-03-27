import SwiftUI

struct InputBar: View {
    @Binding var text: String
    let isStreaming: Bool
    let isConnected: Bool
    let onSend: (String) -> Void
    let onAbort: () -> Void

    @FocusState private var isFocused: Bool

    private let accentPurple = Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255)
    private let barBackground = Color(red: 0x1C / 255, green: 0x1C / 255, blue: 0x2E / 255)
    private let fieldBackground = Color(white: 1, opacity: 0.07)
    private let separatorColor = Color(white: 1, opacity: 0.1)

    private var canSend: Bool {
        isConnected && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isStreaming
    }

    private var placeholderText: String {
        isConnected ? "Message..." : "Disconnected"
    }

    var body: some View {
        VStack(spacing: 0) {
            // Top separator
            Rectangle()
                .fill(separatorColor)
                .frame(height: 0.5)

            HStack(alignment: .bottom, spacing: 10) {
                // Text input area
                textField
                // Action button (send or abort)
                actionButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(barBackground)
        .opacity(isConnected ? 1.0 : 0.5)
        .disabled(!isConnected)
        .animation(.easeInOut(duration: 0.2), value: isStreaming)
    }

    // MARK: - Text Field

    @ViewBuilder
    private var textField: some View {
        ZStack(alignment: .topLeading) {
            // Placeholder
            if text.isEmpty {
                Text(placeholderText)
                    .foregroundColor(.gray)
                    .font(.system(size: 16))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .allowsHitTesting(false)
            }

            TextEditor(text: $text)
                .font(.system(size: 16))
                .foregroundColor(.white)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .frame(minHeight: 38, maxHeight: 100)
                .fixedSize(horizontal: false, vertical: true)
                .focused($isFocused)
                .onSubmit {
                    sendIfPossible()
                }
        }
        .background(fieldBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.white.opacity(0.12), lineWidth: 0.5)
        )
    }

    // MARK: - Action Button

    @ViewBuilder
    private var actionButton: some View {
        if isStreaming {
            Button(action: onAbort) {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.red)
            }
            .transition(.scale.combined(with: .opacity))
            .padding(.bottom, 2)
        } else {
            Button(action: { sendIfPossible() }) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(canSend ? accentPurple : Color.gray.opacity(0.4))
            }
            .disabled(!canSend)
            .transition(.scale.combined(with: .opacity))
            .padding(.bottom, 2)
        }
    }

    // MARK: - Actions

    private func sendIfPossible() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, isConnected, !isStreaming else { return }
        onSend(trimmed)
        text = ""
    }
}

// MARK: - Preview

#Preview("Connected") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            InputBar(
                text: .constant(""),
                isStreaming: false,
                isConnected: true,
                onSend: { _ in },
                onAbort: {}
            )
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Streaming") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            InputBar(
                text: .constant("Hello world"),
                isStreaming: true,
                isConnected: true,
                onSend: { _ in },
                onAbort: {}
            )
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("Disconnected") {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack {
            Spacer()
            InputBar(
                text: .constant(""),
                isStreaming: false,
                isConnected: false,
                onSend: { _ in },
                onAbort: {}
            )
        }
    }
    .preferredColorScheme(.dark)
}

