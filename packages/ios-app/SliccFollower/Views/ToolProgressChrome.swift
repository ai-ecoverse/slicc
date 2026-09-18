import SliccTrayKit
import SwiftUI




















func toolProgressFraction(_ unit: ToolProgressEvent?) -> Double? {
    guard let raw = unit?.fraction, raw.isFinite else { return nil }
    return min(1, max(0, raw))
}





func toolProgressCaption(_ unit: ToolProgressEvent) -> String {
    var parts: [String] = []
    if unit.unit == "iterations", let total = unit.total, total > 0 {
        parts.append("\(Int(unit.done ?? 0))/\(Int(total))")
    }
    if let fraction = toolProgressFraction(unit) {
        parts.append("\(Int((fraction * 100).rounded()))%")
    } else if unit.unit == "bytes", let done = unit.done, done > 0 {
        parts.append(formatProgressBytes(done))
    }
    if let eta = unit.etaMs, eta > 0 {
        parts.append("~\(formatProgressEta(eta))")
    }
    return parts.joined(separator: " · ")
}




func formatProgressBytes(_ bytes: Double) -> String {
    guard bytes.isFinite, bytes >= 0 else { return "" }
    if bytes < 1000 { return "\(Int(bytes.rounded())) B" }
    let units = ["kB", "MB", "GB", "TB"]
    var value = bytes / 1000
    var index = 0
    while value >= 1000, index < units.count - 1 {
        value /= 1000
        index += 1
    }
    return value < 10
        ? String(format: "%.1f %@", value, units[index])
        : "\(Int(value.rounded())) \(units[index])"
}




func formatProgressEta(_ milliseconds: Double) -> String {
    let seconds = max(0, Int((milliseconds / 1000).rounded()))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    if minutes < 60 { return String(format: "%dm%02ds", minutes, seconds % 60) }
    return String(format: "%dh%02dm", minutes / 60, minutes % 60)
}







func aggregateToolProgress(
    calls: [ToolCall], progress: [String: ToolProgressEvent]
) -> ToolProgressEvent? {
    let total = calls.count
    guard total > 0 else { return nil }
    let done = calls.filter { $0.result != nil }.count
    if done == total { return nil }
    let partial =
        calls
        .filter { $0.result == nil }
        .compactMap { toolProgressFraction(progress[$0.id]) }
        .reduce(0, +)
    return ToolProgressEvent(
        id: "cluster",
        label: "\(done) of \(total) done",
        fraction: min(1, (Double(done) + partial) / Double(total)),
        done: Double(done),
        total: Double(total),
        unit: "iterations",
        phase: .update
    )
}







struct ToolProgressIcon: View {
    let glyph: SliccGlyph
    let size: CGFloat
    let unit: ToolProgressEvent?
    let base: Color
    let accent: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    init(
        glyph: SliccGlyph, size: CGFloat, unit: ToolProgressEvent?,
        base: Color, accent: Color
    ) {
        self.glyph = glyph
        self.size = size
        self.unit = unit
        self.base = base
        self.accent = accent
    }

    
    
    init(
        systemName: String, size: CGFloat, unit: ToolProgressEvent?,
        base: Color, accent: Color
    ) {
        self.init(
            glyph: .system(systemName), size: size, unit: unit, base: base,
            accent: accent)
    }

    var body: some View {
        SliccGlyphView(glyph: glyph, size: size)
            .foregroundStyle(fill)
            
            
            .opacity(isBreathing ? 0.45 : 1)
            .animation(
                isIndeterminate && !reduceMotion
                    ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true)
                    : .linear(duration: 0.25),
                value: isBreathing
            )
            .onAppear { breathing = true }
            .accessibilityHidden(true)
    }

    private var isIndeterminate: Bool { unit != nil && toolProgressFraction(unit) == nil }
    private var isBreathing: Bool { isIndeterminate && breathing && !reduceMotion }

    
    
    private var fill: AnyShapeStyle {
        guard let unit else { return AnyShapeStyle(base) }
        guard let fraction = toolProgressFraction(unit) else { return AnyShapeStyle(accent) }
        return AnyShapeStyle(
            LinearGradient(
                stops: [
                    .init(color: accent, location: 0),
                    .init(color: accent, location: fraction),
                    .init(color: base, location: fraction),
                    .init(color: base, location: 1),
                ],
                startPoint: .bottom, endPoint: .top))
    }
}






struct ToolProgressDots: View {
    let unit: ToolProgressEvent
    let color: Color

    private static let count = 3

    var body: some View {
        let fraction = toolProgressFraction(unit)
        let active =
            fraction.map { min(Self.count - 1, Int($0 * Double(Self.count))) } ?? -1
        HStack(spacing: 4) {
            ForEach(0..<Self.count, id: \.self) { index in
                dot(index: index, fraction: fraction, active: active)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(unit.label)
        .accessibilityValue(toolProgressCaption(unit))
    }

    @ViewBuilder
    private func dot(index: Int, fraction: Double?, active: Int) -> some View {
        let isDone = fraction.map { index < active || $0 >= 1 } ?? false
        let isActive = fraction.map { $0 < 1 && index == active } ?? true
        Circle()
            .fill(color)
            .frame(width: 5, height: 5)
            
            
            .opacity(isDone || isActive ? 1 : 0.25)
            .modifier(ToolProgressBlink(active: isActive, delay: Double(index) * 0.2))
    }
}



private struct ToolProgressBlink: ViewModifier {
    let active: Bool
    let delay: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isAnimating = false

    func body(content: Content) -> some View {
        content
            .opacity(active && isAnimating && !reduceMotion ? 0.25 : 1)
            .animation(
                active && !reduceMotion
                    ? .easeInOut(duration: 0.5).repeatForever(autoreverses: true).delay(delay)
                    : .default,
                value: isAnimating
            )
            .onAppear { isAnimating = true }
    }
}






struct ToolProgressBar: View {
    let unit: ToolProgressEvent
    let color: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sliding = false

    var body: some View {
        GeometryReader { geo in
            let fraction = toolProgressFraction(unit)
            Capsule()
                .fill(color)
                .frame(width: geo.size.width * (fraction ?? 0.3))
                .offset(x: indeterminateOffset(width: geo.size.width, fraction: fraction))
                .animation(.linear(duration: 0.25), value: fraction ?? 0)
                .animation(
                    fraction == nil && !reduceMotion
                        ? .easeInOut(duration: 1.2).repeatForever(autoreverses: true) : .default,
                    value: sliding
                )
        }
        .frame(height: 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { sliding = true }
        .accessibilityHidden(true)
    }

    
    
    private func indeterminateOffset(width: CGFloat, fraction: Double?) -> CGFloat {
        guard fraction == nil, !reduceMotion else { return 0 }
        return sliding ? width * 0.7 : 0
    }
}
