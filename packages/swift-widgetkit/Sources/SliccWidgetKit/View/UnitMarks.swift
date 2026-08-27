import SwiftUI

/// The cone and scoop OUTLINE marks, drawn natively in lucide's 24-unit box
/// with lucide's 2-unit round-capped stroke.
///
/// Units are drawn as their agent avatar (`UnitAvatarView`) everywhere it
/// fits. These marks survive in the two places a filled tile cannot go: the
/// monochrome lock-screen accessories, where `.widgetAccentable()` would
/// flatten the tile into a blob, and the empty state, where there is no unit
/// to have an avatar.
///
/// They are SIMPLIFIED redraws of `ice-cream-cone` / `ice-cream-bowl`, not
/// ports of the path data the app renders through `LucideIcon`. A home-screen
/// widget draws these at 12-20pt with no hover, no motion and no second
/// glance, and `ice-cream-bowl`'s three overlapping domes turn into a smudge
/// below about 24pt — so the bowl keeps one dome. The silhouettes stay
/// distinct where it counts: a triangle below the band is a cone, a bowl on a
/// foot is a scoop.
///
/// Reproducing the app's exact glyphs would mean lifting `SVGPath` and
/// `LucideIcon` out of the follower target into this package. That is the
/// right move IF the marks should be identical — see `docs/widgets.md` — but
/// it is a refactor of shared app code, not a widget decision, so it is not
/// made here.
public enum UnitMark {
    /// lucide's box. Every constant below is in these units.
    static let box: CGFloat = 24
    /// lucide's `stroke-width: 2`, in box units.
    static let strokeWidth: CGFloat = 2
}

/// Dome, band, cone — the main agent.
public struct ConeMark: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        var path = Path()

        // Dome: the upper half of a radius-5 circle centred on the band.
        path.addArc(
            center: CGPoint(x: 12, y: 7), radius: 5,
            startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)

        // Band: `a2 2 0 0 1 0 4` on both ends is exactly a capsule.
        path.addRoundedRect(in: CGRect(x: 7, y: 7, width: 10, height: 4), cornerSize: CGSize(width: 2, height: 2))

        // Cone: down to a tip rounded by 1 unit, the way lucide rounds it.
        path.move(to: CGPoint(x: 7, y: 11))
        path.addLine(to: CGPoint(x: 11.35, y: 20.05))
        path.addQuadCurve(to: CGPoint(x: 12.65, y: 20.05), control: CGPoint(x: 12, y: 21.4))
        path.addLine(to: CGPoint(x: 17, y: 11))

        return path.scaled(toFit: rect)
    }
}

/// Bowl, dome, foot — a sandboxed sub-agent.
public struct ScoopMark: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        var path = Path()

        // Bowl: lucide's two cubics, verbatim in geometry if not in syntax.
        path.move(to: CGPoint(x: 12, y: 17))
        path.addCurve(
            to: CGPoint(x: 20, y: 11),
            control1: CGPoint(x: 17, y: 17), control2: CGPoint(x: 20, y: 14.31))
        path.addLine(to: CGPoint(x: 4, y: 11))
        path.addCurve(
            to: CGPoint(x: 12, y: 17),
            control1: CGPoint(x: 4, y: 14.31), control2: CGPoint(x: 7, y: 17))

        // One dome instead of three: see the note on `UnitMark`.
        path.addArc(
            center: CGPoint(x: 12, y: 11), radius: 4.5,
            startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)

        // Foot: stem and base.
        path.move(to: CGPoint(x: 12, y: 17))
        path.addLine(to: CGPoint(x: 12, y: 21))
        path.move(to: CGPoint(x: 8, y: 21))
        path.addLine(to: CGPoint(x: 16, y: 21))

        return path.scaled(toFit: rect)
    }
}

extension Path {
    /// Map a path authored in lucide's 24-unit box onto `rect`, preserving
    /// aspect ratio and centring — the `xMidYMid meet` the web SVG does.
    func scaled(toFit rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / UnitMark.box
        let dx = rect.minX + (rect.width - UnitMark.box * scale) / 2
        let dy = rect.minY + (rect.height - UnitMark.box * scale) / 2
        return applying(
            CGAffineTransform(scaleX: scale, y: scale).concatenating(
                CGAffineTransform(translationX: dx, y: dy)))
    }
}

/// A unit's mark at `size`, stroked in the surrounding `foregroundStyle` with
/// lucide's optical weight held constant across sizes.
public struct UnitMarkView: View {
    public let role: WidgetUnit.Role
    public var size: CGFloat

    public init(role: WidgetUnit.Role, size: CGFloat = 16) {
        self.role = role
        self.size = size
    }

    public var body: some View {
        mark
            .stroke(
                style: StrokeStyle(
                    lineWidth: UnitMark.strokeWidth * size / UnitMark.box,
                    lineCap: .round, lineJoin: .round)
            )
            // The marks touch the box edge, so the stroke straddles it. Inset
            // by half a stroke BEFORE sizing: the caller still gets exactly
            // `size` points and nothing clips.
            .padding(UnitMark.strokeWidth * size / (UnitMark.box * 2))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    /// `AnyShape` rather than a `@ViewBuilder`: the two marks have to reach
    /// `.stroke` as a *shape*, and `some View` would erase that.
    private var mark: AnyShape {
        switch role {
        case .cone: AnyShape(ConeMark())
        case .scoop: AnyShape(ScoopMark())
        }
    }
}
