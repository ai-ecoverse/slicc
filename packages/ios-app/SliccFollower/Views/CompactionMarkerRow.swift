import SliccTrayKit
import SwiftUI

struct CompactionMarkerRow: View, Equatable {
    let marker: ChatCompactionMarker

    @Environment(\.palette) private var palette

    static func == (lhs: CompactionMarkerRow, rhs: CompactionMarkerRow) -> Bool {
        lhs.marker == rhs.marker
    }

    private static let amber = Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255)

    private var glyph: SliccGlyph {
        switch marker.state {
        case .summarizing: return .system("arrow.triangle.2.circlepath")
        case .summarized: return .system("archivebox")
        case .fallback: return .system("exclamationmark.triangle")

        case .discarded: return .system("archivebox")
        }
    }

    private var label: String {
        switch marker.state {
        case .summarizing:
            switch marker.trigger {
            case .idle: return "Idle — compacting history in the background"
            case .threshold: return "Context filling up — compacting history"
            case .overflow: return "Context overflowed — compacting history"
            }
        case .summarized, .discarded:
            switch marker.trigger {
            case .idle: return "Compacted while idle"
            case .threshold: return "History compacted"
            case .overflow: return "Context overflowed — history compacted"
            }
        case .fallback:
            return "Summary unavailable — older messages truncated"
        }
    }

    private var isDegraded: Bool { marker.state == .fallback }

    private var chipInk: Color {
        isDegraded ? Self.amber.mix(with: palette.ink, by: 0.45) : palette.inkTertiary
    }

    private var chipBorder: Color {
        isDegraded ? Self.amber.opacity(0.45) : palette.line
    }

    private var chipBackground: Color {
        isDegraded ? Self.amber.opacity(0.12) : palette.field
    }

    private var transcriptName: String? {
        guard let path = marker.transcriptPath, !path.isEmpty else { return nil }
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        return trimmed.split(separator: "/").last.map(String.init) ?? trimmed
    }

    var body: some View {
        HStack(spacing: 10) {
            rule
            chip
            rule
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("compaction-marker-\(marker.state.rawValue)")
        .accessibilityLabel(
            marker.transcriptPath.map { "\(label). Full transcript \($0)" } ?? label)
    }

    private var rule: some View {
        Rectangle()
            .fill(palette.line)
            .frame(height: 1)
    }

    private var chip: some View {
        HStack(spacing: 6) {
            SliccGlyphView(glyph: glyph, size: 11)

                .opacity(marker.state == .summarizing ? 0.55 : 1)
            Text(label)
                .font(.system(size: 11))
                .lineLimit(1)
            if let name = transcriptName {
                Text(name)
                    .font(.system(size: 10, design: .monospaced))
                    .underline()
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .opacity(0.8)
                    .accessibilityIdentifier("compaction-marker-transcript")
            }
        }
        .foregroundStyle(chipInk)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(
            Capsule().fill(chipBackground)
        )
        .overlay(
            Capsule().strokeBorder(chipBorder, lineWidth: 1)
        )

        .layoutPriority(1)
    }
}
