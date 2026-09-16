import SwiftUI

enum LucideGlyph: String, CaseIterable {
    case iceCreamCone = "ice-cream-cone"
    case iceCreamBowl = "ice-cream-bowl"

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

struct LucideShape: Shape {
    let glyph: LucideGlyph

    func path(in rect: CGRect) -> Path {
        Path(SVGPath.fitted(glyph.unitPath, in: rect))
    }
}

struct LucideIcon: View {
    let glyph: LucideGlyph
    var size: CGFloat = 16

    var strokeWidth: CGFloat = 2

    var body: some View {
        LucideShape(glyph: glyph)
            .stroke(
                style: StrokeStyle(
                    lineWidth: strokeWidth * size / 24,
                    lineCap: .round,
                    lineJoin: .round)
            )

            .padding(strokeWidth * size / 48)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

enum SliccGlyph: Equatable {
    case system(String)
    case lucide(LucideGlyph)
}

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

struct ConeScoopGlyph: View {
    let isCone: Bool
    var size: CGFloat = 16

    var body: some View {
        LucideIcon(glyph: isCone ? .iceCreamCone : .iceCreamBowl, size: size)
            .accessibilityLabel(isCone ? "Cone" : "Scoop")
    }
}

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
