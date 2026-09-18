import SwiftUI












struct Base64Chip: View {
    let payload: Base64Payload

    @Environment(\.palette) private var palette
    @Environment(\.transcriptActions) private var actions

    var body: some View {
        Button {
            actions.preview(.payload(payload))
        } label: {
            HStack(spacing: 6) {
                Image(systemName: Self.icon(for: payload.mime))
                    .font(.system(size: 14))
                    .foregroundStyle(palette.ink.opacity(0.6))
                Text(label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(palette.ink.opacity(0.85))
                    .lineLimit(1)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(palette.field)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(palette.ink.opacity(0.10), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("base64-chip")
        .accessibilityLabel("\(payload.mime), \(payload.bytes.count) bytes. Double tap to preview.")
        .contextMenu {
            Button {
                actions.preview(.payload(payload))
            } label: {
                Label("Preview", systemImage: "eye")
            }
            Button {
                actions.share(.blob(name: payload.name, data: payload.bytes))
            } label: {
                Label("Share…", systemImage: "square.and.arrow.up")
            }
            Button {
                TranscriptClipboard.copy(payload.bytes.base64EncodedString())
            } label: {
                Label("Copy Base64", systemImage: "doc.on.doc")
            }
        }
    }

    private var label: String {
        "\(payload.shortLabel) · \(Self.size(payload.bytes.count))"
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    
    
    static func icon(for mime: String) -> String {
        switch true {
        case mime.hasPrefix("image/"): return "photo"
        case mime.hasPrefix("audio/"): return "waveform"
        case mime.hasPrefix("video/"): return "film"
        case mime.hasPrefix("text/"): return "doc.text"
        default: return "doc"
        }
    }
}
