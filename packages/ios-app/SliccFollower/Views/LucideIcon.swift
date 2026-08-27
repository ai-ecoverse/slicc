import SwiftUI

// MARK: - Glyph registry

/// Lucide glyphs ported as their literal upstream path data.
///
/// The web UI renders every icon from lucide
/// (`packages/webcomponents/src/internal/icons.ts` — "NOT emoji or bespoke
/// glyphs"), and the phone approximated them with SF Symbols. That works for
/// generic nouns, but SF Symbols has no ice cream cone, so the cone — the
/// product's central metaphor — was rendering as a teacup, and scoops as a
/// 2x2 grid. Neither reads as SLICC.
///
/// Only the glyphs the phone actually needs are ported; adding one means
/// pasting its `d` string from `node_modules/lucide/dist/esm/icons/<name>.js`.
/// Icons are lucide v1.8.0, ISC licensed (Copyright Lucide Icons and
/// Contributors), on a 24x24 viewBox with 2px round-capped strokes.
enum LucideGlyph: String, CaseIterable {
    case iceCreamCone = "ice-cream-cone"
    case iceCreamBowl = "ice-cream-bowl"

    /// The `d` strings of the glyph's `<path>` children, verbatim.
    var pathData: [String] {
        switch self {
        case .iceCreamCone:
            return [
                "m7 11 4.08 10.35a1 1 0 0 0 1.84 0L17 11",
                "M17 7A5 5 0 0 0 7 7",
                "M17 7a2 2 0 0 1 0 4H7a2 2 0 0 1 0-4",
            ]
        case .iceCreamBowl:
            return [
                "M12 17c5 0 8-2.69 8-6H4c0 3.31 3 6 8 6m-4 4h8m-4-3v3M5.14 11a3.5 3.5 0 1 1 6.71 0",
                "M12.14 11a3.5 3.5 0 1 1 6.71 0",
                "M15.5 6.5a3.5 3.5 0 1 0-7 0",
            ]
        }
    }
}

extension LucideGlyph {
    /// The glyph parsed once, in its own 24-unit space.
    ///
    /// `Shape.path(in:)` is called on every layout pass, and re-parsing
    /// arc-heavy path data per frame is expensive enough to make a screen
    /// full of glyphs visibly slow. The set is tiny and immutable, so it is
    /// parsed eagerly on first use and reused forever after.
    var unitPath: CGPath {
        Self.unitPaths[self] ?? CGMutablePath()
    }

    private static let unitPaths: [LucideGlyph: CGPath] = {
        var built: [LucideGlyph: CGPath] = [:]
        for glyph in LucideGlyph.allCases {
            let combined = CGMutablePath()
            for data in glyph.pathData {
                combined.addPath(SVGPath.parse(data))
            }
            built[glyph] = combined
        }
        return built
    }()
}

// MARK: - Shape

/// The glyph's outline in a given rect. Separate from the view so it can be
/// stroked, animated or masked like any other `Shape`.
struct LucideShape: Shape {
    let glyph: LucideGlyph

    func path(in rect: CGRect) -> Path {
        Path(SVGPath.fitted(glyph.unitPath, in: rect))
    }
}

// MARK: - View

/// A lucide glyph rendered at `size`, tinted by the surrounding
/// `foregroundStyle` like an SF Symbol.
///
/// Stroke width scales with the glyph so a 13pt cone keeps lucide's optical
/// weight rather than turning into a smudge — the web sets `stroke-width: 2`
/// against a fixed 24px box, so the equivalent here is proportional.
struct LucideIcon: View {
    let glyph: LucideGlyph
    var size: CGFloat = 16
    /// Stroke width in the glyph's own 24-unit space (lucide's default is 2).
    var strokeWidth: CGFloat = 2

    var body: some View {
        LucideShape(glyph: glyph)
            .stroke(
                style: StrokeStyle(
                    lineWidth: strokeWidth * size / 24,
                    lineCap: .round,
                    lineJoin: .round)
            )
            // Lucide glyphs touch the edge of the 24-unit box, so the stroke
            // straddles it. Inset by half a stroke BEFORE sizing, so the
            // caller still gets exactly `size` points and nothing clips.
            .padding(strokeWidth * size / 48)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

// MARK: - Shared glyph (SF Symbol or ported Lucide)

/// A transcript / rail glyph that is either an SF Symbol or a ported Lucide
/// path. Ice-cream metaphors have no SF Symbol, so those land on `.lucide`.
enum SliccGlyph: Equatable {
    case system(String)
    case lucide(LucideGlyph)
}

/// Renders a `SliccGlyph` at `size`, tinted by the surrounding
/// `foregroundStyle` like an SF Symbol.
struct SliccGlyphView: View {
    let glyph: SliccGlyph
    var size: CGFloat = 16

    var body: some View {
        switch glyph {
        case .system(let name):
            Image(systemName: name)
                .font(.system(size: size))
        case .lucide(let lucide):
            LucideIcon(glyph: lucide, size: size)
        }
    }
}

// MARK: - Cone / scoop identity

/// The cone-vs-scoop glyph, in one place so the switcher, the transcript and
/// the monitor cannot drift apart. The cone is the session's main agent; a
/// scoop is a sandboxed sub-agent.
struct ConeScoopGlyph: View {
    let isCone: Bool
    var size: CGFloat = 16

    var body: some View {
        LucideIcon(glyph: isCone ? .iceCreamCone : .iceCreamBowl, size: size)
            .accessibilityLabel(isCone ? "Cone" : "Scoop")
    }
}

// MARK: - Preview

#Preview {
    VStack(spacing: 24) {
        HStack(spacing: 20) {
            ConeScoopGlyph(isCone: true, size: 13)
            ConeScoopGlyph(isCone: true, size: 24)
            ConeScoopGlyph(isCone: true, size: 48)
        }
        .foregroundStyle(.purple)
        HStack(spacing: 20) {
            ConeScoopGlyph(isCone: false, size: 13)
            ConeScoopGlyph(isCone: false, size: 24)
            ConeScoopGlyph(isCone: false, size: 48)
        }
        .foregroundStyle(.teal)
    }
    .padding()
}
