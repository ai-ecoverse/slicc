import CoreGraphics
import Foundation

/// Minimal SVG path-data parser (`d` attribute) → `CGPath`.
///
/// Exists so lucide glyphs can be ported into the app as their literal
/// upstream path strings instead of being re-approximated by whichever SF
/// Symbol looks closest. The web UI renders lucide for every glyph
/// (`packages/webcomponents/src/internal/icons.ts`), and SF Symbols has no
/// ice cream cone at all — the cone, the product's central metaphor, was
/// standing in as a teacup.
///
/// Supports the command set lucide actually emits: `M m L l H h V v C c S s
/// Q q T t A a Z z`. Unknown commands abort the parse and yield whatever was
/// built so far, so a bad glyph is a missing glyph, never a crash.
enum SVGPath {

    /// Parse `d` and scale the result from `viewBox`×`viewBox` into `rect`,
    /// preserving aspect ratio and centering the remainder.
    static func path(from data: String, viewBox: CGFloat = 24, in rect: CGRect) -> CGPath {
        fitted(parse(data), viewBox: viewBox, in: rect)
    }

    /// Scale an already-parsed path from `viewBox`×`viewBox` into `rect`.
    /// Split out because `Shape.path(in:)` runs on every layout pass, so
    /// glyph parsing has to happen once and only the transform per frame.
    static func fitted(_ path: CGPath, viewBox: CGFloat = 24, in rect: CGRect) -> CGPath {
        let scale = min(rect.width, rect.height) / viewBox
        var transform = CGAffineTransform(
            translationX: rect.minX + (rect.width - viewBox * scale) / 2,
            y: rect.minY + (rect.height - viewBox * scale) / 2
        )
        .scaledBy(x: scale, y: scale)
        return path.copy(using: &transform) ?? path
    }

    /// Parse `d` in its own coordinate space.
    static func parse(_ data: String) -> CGPath {
        let path = CGMutablePath()
        var tokens = Tokenizer(data)
        var pen = Pen()
        var command: Character?
        while let cmd = nextCommand(&tokens, after: command) {
            command = cmd
            guard apply(cmd, &tokens, &pen, to: path) else { break }
            if tokens.atEnd { break }
        }
        return path
    }

    /// The pen state threaded through every command.
    private struct Pen {
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero
        /// Reflection anchors for smooth curves (`S`/`T`); nil means the
        /// reflection collapses to the current point, per the SVG spec.
        var lastCubicControl: CGPoint?
        var lastQuadControl: CGPoint?

        func point(_ x: CGFloat, _ y: CGFloat, relative: Bool) -> CGPoint {
            relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        }

        /// Every command except `S`/`T` clears the smooth-curve anchors.
        mutating func clearReflections() {
            lastCubicControl = nil
            lastQuadControl = nil
        }
    }

    /// Which command the next operands belong to: an explicit letter, or the
    /// implicit repeat of the previous one (`M 0 0 4 0 4 4` is a moveto plus
    /// two linetos).
    private static func nextCommand(
        _ tokens: inout Tokenizer, after previous: Character?
    ) -> Character? {
        if let next = tokens.peekCommand() {
            tokens.advanceCommand()
            return next
        }
        guard !tokens.atEnd, let previous else { return nil }
        switch previous {
        case "M": return "L"
        case "m": return "l"
        // `Z` consumes no operands, so repeating it would spin forever.
        case "Z", "z": return nil
        default: return previous
        }
    }

    /// Returns false when the operands ran out or the command is unknown —
    /// a malformed glyph then renders as far as it parsed.
    private static func apply(
        _ cmd: Character, _ tokens: inout Tokenizer, _ pen: inout Pen, to path: CGMutablePath
    ) -> Bool {
        switch cmd {
        case "M", "m", "L", "l", "H", "h", "V", "v":
            return applyStraight(cmd, &tokens, &pen, to: path)
        case "C", "c", "S", "s", "Q", "q", "T", "t":
            return applyCurve(cmd, &tokens, &pen, to: path)
        case "A", "a":
            return applyArc(cmd, &tokens, &pen, to: path)
        case "Z", "z":
            if !path.isEmpty { path.closeSubpath() }
            pen.current = pen.subpathStart
            pen.clearReflections()
            return true
        default:
            return false
        }
    }

    private static func applyStraight(
        _ cmd: Character, _ tokens: inout Tokenizer, _ pen: inout Pen, to path: CGMutablePath
    ) -> Bool {
        let relative = cmd.isLowercase
        switch cmd {
        case "H", "h":
            guard let x = tokens.number() else { return false }
            pen.current = CGPoint(x: relative ? pen.current.x + x : x, y: pen.current.y)
        case "V", "v":
            guard let y = tokens.number() else { return false }
            pen.current = CGPoint(x: pen.current.x, y: relative ? pen.current.y + y : y)
        default:
            guard let x = tokens.number(), let y = tokens.number() else { return false }
            pen.current = pen.point(x, y, relative: relative)
        }
        if cmd == "M" || cmd == "m" {
            pen.subpathStart = pen.current
            path.move(to: pen.current)
        } else {
            path.addLine(to: pen.current)
        }
        pen.clearReflections()
        return true
    }

    private static func applyCurve(
        _ cmd: Character, _ tokens: inout Tokenizer, _ pen: inout Pen, to path: CGMutablePath
    ) -> Bool {
        let relative = cmd.isLowercase
        switch cmd {
        case "C", "c":
            guard let x1 = tokens.number(), let y1 = tokens.number(),
                let x2 = tokens.number(), let y2 = tokens.number(),
                let x = tokens.number(), let y = tokens.number()
            else { return false }
            addCubic(
                pen.point(x1, y1, relative: relative), pen.point(x2, y2, relative: relative),
                pen.point(x, y, relative: relative), &pen, to: path)
        case "S", "s":
            guard let x2 = tokens.number(), let y2 = tokens.number(),
                let x = tokens.number(), let y = tokens.number()
            else { return false }
            addCubic(
                reflect(pen.lastCubicControl, about: pen.current),
                pen.point(x2, y2, relative: relative),
                pen.point(x, y, relative: relative), &pen, to: path)
        case "Q", "q":
            guard let x1 = tokens.number(), let y1 = tokens.number(),
                let x = tokens.number(), let y = tokens.number()
            else { return false }
            addQuad(
                pen.point(x1, y1, relative: relative),
                pen.point(x, y, relative: relative), &pen, to: path)
        default:
            guard let x = tokens.number(), let y = tokens.number() else { return false }
            addQuad(
                reflect(pen.lastQuadControl, about: pen.current),
                pen.point(x, y, relative: relative), &pen, to: path)
        }
        return true
    }

    private static func addCubic(
        _ control1: CGPoint, _ control2: CGPoint, _ end: CGPoint, _ pen: inout Pen,
        to path: CGMutablePath
    ) {
        pen.current = end
        path.addCurve(to: end, control1: control1, control2: control2)
        pen.clearReflections()
        pen.lastCubicControl = control2
    }

    private static func addQuad(
        _ control: CGPoint, _ end: CGPoint, _ pen: inout Pen, to path: CGMutablePath
    ) {
        pen.current = end
        path.addQuadCurve(to: end, control: control)
        pen.clearReflections()
        pen.lastQuadControl = control
    }

    private static func applyArc(
        _ cmd: Character, _ tokens: inout Tokenizer, _ pen: inout Pen, to path: CGMutablePath
    ) -> Bool {
        guard let rx = tokens.number(), let ry = tokens.number(),
            let rotation = tokens.number(), let largeArc = tokens.flag(),
            let sweep = tokens.flag(), let x = tokens.number(), let y = tokens.number()
        else { return false }
        let end = pen.point(x, y, relative: cmd.isLowercase)
        appendArc(
            to: path, from: pen.current, to: end, rx: rx, ry: ry,
            xRotationDegrees: rotation, largeArc: largeArc, sweep: sweep)
        pen.current = end
        pen.clearReflections()
        return true
    }

    private static func reflect(_ control: CGPoint?, about current: CGPoint) -> CGPoint {
        guard let control else { return current }
        return CGPoint(x: 2 * current.x - control.x, y: 2 * current.y - control.y)
    }

    // MARK: - Elliptical arcs

    /// Endpoint → center parameterization (SVG spec F.6.5), then one cubic
    /// per ≤90° slice. Hand-converting lucide's arcs was the alternative;
    /// this keeps the upstream `d` strings pasteable verbatim.
    private static func appendArc(
        to path: CGMutablePath,
        from start: CGPoint,
        to end: CGPoint,
        rx: CGFloat,
        ry: CGFloat,
        xRotationDegrees: CGFloat,
        largeArc: Bool,
        sweep: Bool
    ) {
        // Degenerate radii mean a straight line, per the spec.
        var rx = abs(rx)
        var ry = abs(ry)
        guard rx > 0, ry > 0, start != end else {
            path.addLine(to: end)
            return
        }
        // `addCurve` needs a current point; an arc that opens a subpath is
        // malformed but must not trap.
        if path.isEmpty { path.move(to: start) }

        let phi = xRotationDegrees * .pi / 180
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)

        let dx2 = (start.x - end.x) / 2
        let dy2 = (start.y - end.y) / 2
        let x1p = cosPhi * dx2 + sinPhi * dy2
        let y1p = -sinPhi * dx2 + cosPhi * dy2

        // Scale up radii that are too small to span the chord (F.6.6).
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            let scale = sqrt(lambda)
            rx *= scale
            ry *= scale
        }

        let sign: CGFloat = largeArc == sweep ? -1 : 1
        let numerator = max(
            0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p)
        let denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        let coefficient = denominator == 0 ? 0 : sign * sqrt(numerator / denominator)
        let cxp = coefficient * rx * y1p / ry
        let cyp = -coefficient * ry * x1p / rx

        let cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
            guard len > 0 else { return 0 }
            let value = min(1, max(-1, dot / len))
            let result = acos(value)
            return (ux * vy - uy * vx) < 0 ? -result : result
        }

        let startVectorX = (x1p - cxp) / rx
        let startVectorY = (y1p - cyp) / ry
        let endVectorX = (-x1p - cxp) / rx
        let endVectorY = (-y1p - cyp) / ry
        let theta1 = angle(1, 0, startVectorX, startVectorY)
        var delta = angle(startVectorX, startVectorY, endVectorX, endVectorY)
        if !sweep, delta > 0 {
            delta -= 2 * .pi
        } else if sweep, delta < 0 {
            delta += 2 * .pi
        }

        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        // Standard cubic approximation constant for a circular arc slice.
        let alpha = 4.0 / 3.0 * tan(step / 4)

        var theta = theta1
        for _ in 0..<segments {
            let cosTheta1 = cos(theta)
            let sinTheta1 = sin(theta)
            let theta2 = theta + step
            let cosTheta2 = cos(theta2)
            let sinTheta2 = sin(theta2)

            func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(
                    x: cx + cosPhi * rx * x - sinPhi * ry * y,
                    y: cy + sinPhi * rx * x + cosPhi * ry * y)
            }

            let point2 = map(cosTheta2, sinTheta2)
            let control1 = map(
                cosTheta1 - alpha * sinTheta1, sinTheta1 + alpha * cosTheta1)
            let control2 = map(
                cosTheta2 + alpha * sinTheta2, sinTheta2 - alpha * cosTheta2)
            path.addCurve(to: point2, control1: control1, control2: control2)
            theta = theta2
        }
    }

    // MARK: - Tokenizer

    /// Scans a `d` string. SVG path data allows commas, arbitrary whitespace,
    /// implicit `+`/`-` separators and exponent notation, so hand-splitting
    /// on whitespace is not enough.
    private struct Tokenizer {
        private let scalars: [Character]
        private var index: Int = 0

        init(_ data: String) {
            scalars = Array(data)
        }

        var atEnd: Bool {
            var probe = index
            while probe < scalars.count, isSeparator(scalars[probe]) { probe += 1 }
            return probe >= scalars.count
        }

        private func isSeparator(_ char: Character) -> Bool {
            char == " " || char == "," || char == "\n" || char == "\t" || char == "\r"
        }

        private mutating func skipSeparators() {
            while index < scalars.count, isSeparator(scalars[index]) { index += 1 }
        }

        mutating func peekCommand() -> Character? {
            skipSeparators()
            guard index < scalars.count else { return nil }
            let char = scalars[index]
            return "MmLlHhVvCcSsQqTtAaZz".contains(char) ? char : nil
        }

        mutating func advanceCommand() {
            index += 1
        }

        /// Arc flags are single characters and may be written unseparated
        /// (`a1 1 0 1 1 …` and `a1 1 0 11 …` are both legal).
        mutating func flag() -> Bool? {
            skipSeparators()
            guard index < scalars.count else { return nil }
            let char = scalars[index]
            guard char == "0" || char == "1" else { return nil }
            index += 1
            return char == "1"
        }

        mutating func number() -> CGFloat? {
            skipSeparators()
            guard index < scalars.count else { return nil }
            var text = ""
            if scalars[index] == "-" || scalars[index] == "+" {
                text.append(scalars[index])
                index += 1
            }
            var sawDigit = false
            var sawDot = false
            while index < scalars.count {
                let char = scalars[index]
                if char.isNumber {
                    sawDigit = true
                } else if char == ".", !sawDot {
                    sawDot = true
                } else if char == "e" || char == "E", sawDigit {
                    // Exponent: consume it plus an optional sign.
                    text.append(char)
                    index += 1
                    if index < scalars.count, scalars[index] == "-" || scalars[index] == "+" {
                        text.append(scalars[index])
                        index += 1
                    }
                    continue
                } else {
                    break
                }
                text.append(char)
                index += 1
            }
            guard sawDigit, let value = Double(text) else { return nil }
            return CGFloat(value)
        }
    }
}
