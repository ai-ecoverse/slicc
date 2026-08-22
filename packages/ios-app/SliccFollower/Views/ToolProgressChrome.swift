import SliccTrayKit
import SwiftUI

// MARK: - Tool progress chrome
//
// Native mirror of the webapp's bash progress overlay (#2282,
// `applyProgressTreatment` in `packages/webapp/src/ui/wc/wc-message-view.ts`).
// The web treatment is three quiet cues on the row's own chrome — no separate
// widget — and this keeps that contract:
//
//  1. the tool icon fills bottom-up with the accent (indeterminate: breathes);
//  2. the trailing spinner becomes three dots, one per third, the active one
//     blinking;
//  3. an EXPANDED row body wears a thin top bar — row-only, never on a cluster
//     head, because a bar over a summary of N calls reads as noise.
//
// A phone adds one thing the web leaves to the hover title: the percentage and
// ETA are always visible, since there is no cursor to hover with.

/// Clamped 0...1 fraction, or `nil` for an indeterminate unit.
func toolProgressFraction(_ unit: ToolProgressEvent?) -> Double? {
    guard let raw = unit?.fraction, raw.isFinite else { return nil }
    return min(1, max(0, raw))
}

/// Trailing caption: "43% · ~8s", "12.4 MB", "3/12". The parts the web packs
/// into the row's hover `title` (`progressTitle`), minus the label — the row
/// already shows the command it is running — and minus the word "left", which
/// a nested cluster row has no width for.
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

/// Byte counter for a `unit: "bytes"` tick, matching the web's `formatBytes`.
func formatProgressBytes(_ bytes: Double) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"]
    var value = bytes
    var index = 0
    while value >= 1024, index < units.count - 1 {
        value /= 1024
        index += 1
    }
    return value < 10 && index > 0
        ? String(format: "%.1f %@", value, units[index])
        : "\(Int(value.rounded())) \(units[index])"
}

/// Coarse remaining-time string ("8s", "2m"), matching the web's `formatEta`.
func formatProgressEta(_ milliseconds: Double) -> String {
    let seconds = Int((milliseconds / 1000).rounded())
    if seconds < 60 { return "\(max(1, seconds))s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    return "\(minutes / 60)h"
}

/// Fold a cluster's calls into ONE determinate unit — "how far through this
/// batch are we", not "how fast is the current command". Direct port of
/// `aggregateClusterProgress`: the batch size is known before any call
/// finishes, so this is `(finished + partial) / total` and never
/// indeterminate. Returns `nil` once nothing is running, which clears the
/// treatment.
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

// MARK: - Icon fill

/// The row's tool glyph, filling bottom-up with the accent as the unit
/// advances — the native form of the web's
/// `linear-gradient(to top, accent calc(var(--slicc-progress)*100%), dim 0)`.
/// Without a unit it is exactly the icon the row rendered before.
struct ToolProgressIcon: View {
    let systemName: String
    let size: CGFloat
    let unit: ToolProgressEvent?
    let base: Color
    let accent: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size))
            .foregroundStyle(fill)
            // An indeterminate unit has no level to show, so the whole glyph
            // breathes instead — the web's `wcmsg-progress-breathe`.
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

    /// A hard-stop gradient across the glyph: accent up to the fraction, the
    /// row's own dim ink above it. No unit at all keeps the plain ink.
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

// MARK: - Dots

/// Three dots standing in for the running row's spinner: each owns a third of
/// the run, finished thirds are solid, the one holding the current position
/// blinks. An indeterminate unit blinks all three in sequence.
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
            .opacity(isDone ? 1 : 0.25)
            .modifier(ToolProgressBlink(active: isActive, delay: Double(index) * 0.2))
    }
}

/// Blink for the active dot. Mirrors `wcmsg-progress-blink`; a dot that is not
/// active keeps whatever opacity the caller set.
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

// MARK: - Body bar

/// The thin bar an EXPANDED row wears above its body — the native counterpart
/// of `.slicc-act__body::before`. Deliberately row-only: a cluster head
/// advances through its icon fill and dots alone.
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

    /// An indeterminate bar is a short capsule sweeping the row; a determinate
    /// one is pinned to the leading edge.
    private func indeterminateOffset(width: CGFloat, fraction: Double?) -> CGFloat {
        guard fraction == nil, !reduceMotion else { return 0 }
        return sliding ? width * 0.7 : 0
    }
}
