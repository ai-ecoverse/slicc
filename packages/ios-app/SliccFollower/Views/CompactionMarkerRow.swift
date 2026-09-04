import SliccTrayKit
import SwiftUI

// MARK: - CompactionMarkerRow

/// The transcript seam marking one context-compaction round — a hairline rule
/// broken by a chip naming what happened, plus the pre-compaction transcript's
/// filename when a snapshot was written.
///
/// Mirrors `<slicc-compaction-marker>` in `@slicc/webcomponents`: same
/// geometry (rule · chip · rule), same glyph-per-state choice, and the same
/// copy table. The wire carries `trigger` + `state` and never prose precisely
/// so this file can own its own wording (see `ChatCompactionMarker`); the two
/// tables are a pair, so a copy change here means one there.
///
/// It exists because a compaction is not something anyone SAID. The leader used
/// to render it as an assistant bubble, which put the model's voice on a piece
/// of bookkeeping — and the fake assistant turn it took to fabricate one left
/// consumers holding turn state that nothing would ever close (#2843).
///
/// `Equatable` for the same reason `MessageBubble` is: the transcript
/// re-evaluates rows constantly, and SwiftUI can only skip an unchanged row
/// when the row's value compares equal.
struct CompactionMarkerRow: View, Equatable {
    let marker: ChatCompactionMarker

    @Environment(\.palette) private var palette

    /// The web's `--amber`. Not a `ThemePalette` token: this is the only
    /// surface in the app that needs it, and adding a token would mean
    /// resolving it in every palette AND in the leader-theme reader for one
    /// chip.
    private static let amber = Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255)

    /// Leading glyph per state — the state, not the trigger, picks the icon.
    /// SF Symbol choices mirror the lucide names the web component uses:
    /// `loader` → `arrow.triangle.2.circlepath`, `archive` → `archivebox`,
    /// `triangle-alert` → `exclamationmark.triangle`.
    private var glyph: SliccGlyph {
        switch marker.state {
        case .summarizing: return .system("arrow.triangle.2.circlepath")
        case .summarized: return .system("archivebox")
        case .fallback: return .system("exclamationmark.triangle")
        // Unreachable: `applyCompactionNotice` removes the row instead of
        // rendering a discarded round. Kept exhaustive so a new state is a
        // compile error rather than a silently mis-iconed row.
        case .discarded: return .system("archivebox")
        }
    }

    /// The copy table. Paired with `LABEL` in
    /// `packages/webcomponents/src/chat/slicc-compaction-marker.ts`.
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

    /// Amber mixed toward the ink, for the same reason the web chip mixes it:
    /// raw amber at 11pt is unreadable on the light canvas.
    private var chipInk: Color {
        isDegraded ? Self.amber.mix(with: palette.ink, by: 0.45) : palette.inkTertiary
    }

    private var chipBorder: Color {
        isDegraded ? Self.amber.opacity(0.45) : palette.line
    }

    private var chipBackground: Color {
        isDegraded ? Self.amber.opacity(0.12) : palette.field
    }

    /// Last path segment; the full path stays in the accessibility label.
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
                // A slow breath rather than a spin: it reads as "in flight"
                // without a continuously animating icon in a scrolling list.
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
        // The chip yields to the rules rather than pushing them off screen.
        .layoutPriority(1)
    }
}
