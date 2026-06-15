#if os(macOS)
import Foundation
import AppKit

/// Pure decision for "given an accessibility element under the mouse, should
/// we emit a `click` beacon, and with what `source` / `target`?".
///
/// The macOS click monitor is intentionally a thin shell around this enum so
/// the emit-or-skip rules (including the documented `optel-ignore` opt-out)
/// are exercised by ordinary unit tests rather than by driving live AppKit
/// events.
public enum OptelClickEmitDecider {
    /// Accessibility identifier marker that opts an element (and its entire
    /// subtree) out of click emission. Set this as the `accessibilityIdentifier`
    /// on any `NSView` whose interactions must not produce RUM beacons —
    /// typically password fields or other PII-bearing controls. The opt-out is
    /// inherited: if any ancestor along the hit-test chain carries this
    /// marker, the click is skipped.
    public static let ignoreIdentifier = "optel-ignore"

    /// Result of evaluating a hit element. When `shouldEmit` is `false`, both
    /// `source` and `target` are `nil`.
    public struct Decision: Equatable, Sendable {
        public let shouldEmit: Bool
        public let source: String?
        public let target: String?

        public init(shouldEmit: Bool, source: String?, target: String?) {
            self.shouldEmit = shouldEmit
            self.source = source
            self.target = target
        }
    }

    /// Skip-decision used when there's nothing to emit (nil element, opt-out
    /// marker present, etc.).
    public static let skip = Decision(shouldEmit: false, source: nil, target: nil)

    /// Decide whether to emit `click` for `element`. Returns ``skip`` when:
    /// - `element` is `nil` (hit-test failed or no key window),
    /// - `element` (or any ancestor up to ``OptelAccessibilityDeriver/maxAncestorDepth``)
    ///   carries the ``ignoreIdentifier`` opt-out marker.
    ///
    /// Otherwise delegates to ``OptelAccessibilityDeriver/derive(from:)`` and
    /// returns an emit decision with the derived `source` / `target`.
    public static func decide(for element: OptelAccessibleElement?) -> Decision {
        guard let element else { return skip }
        if hasIgnoreMarker(in: element) { return skip }
        let derived = OptelAccessibilityDeriver.derive(from: element)
        return Decision(shouldEmit: true, source: derived.source, target: derived.target)
    }

    /// Walks the ancestor chain looking for the ``ignoreIdentifier`` marker
    /// on any element's `optelAccessibilityIdentifier`. Whitespace-only
    /// identifiers are treated as absent (matching the deriver's policy).
    static func hasIgnoreMarker(in element: OptelAccessibleElement) -> Bool {
        var current: OptelAccessibleElement? = element
        var depth = 0
        while let node = current, depth < OptelAccessibilityDeriver.maxAncestorDepth {
            if let identifier = node.optelAccessibilityIdentifier?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                identifier == ignoreIdentifier {
                return true
            }
            current = node.optelAccessibilityParent
            depth += 1
        }
        return false
    }
}

/// macOS-only app-level click monitor. Installs a single
/// `NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp])` handler that
/// hit-tests the source window's content view, runs ``OptelClickEmitDecider``,
/// and emits a `click` beacon via ``Optel/sample(_:source:target:value:)`` for
/// non-opt-out elements. The monitor **always returns the event unmodified**
/// so clicks are never swallowed.
///
/// Install/uninstall is idempotent; a second `installIfNeeded()` is a no-op,
/// and `uninstall()` is safe to call when nothing is installed. The actual
/// emit/skip decision lives in ``OptelClickEmitDecider`` so the rules are
/// unit-tested in pure Swift without a running app.
public enum OptelClickMonitor {
    private static let lock = NSLock()
    private static var installed = false
    private static var monitor: Any?

    /// `true` once the monitor has been installed for this process.
    public static var isInstalled: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    /// Install the local `.leftMouseUp` monitor. Safe to call repeatedly; the
    /// second and subsequent calls are no-ops so the monitor is never retained
    /// twice.
    public static func installIfNeeded() {
        lock.lock()
        guard !installed else {
            lock.unlock()
            return
        }
        installed = true
        let token = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { event in
            OptelClickMonitor.handle(event: event)
            return event
        }
        monitor = token
        lock.unlock()
    }

    /// Remove the installed monitor. Safe to call when nothing is installed.
    public static func uninstall() {
        lock.lock()
        let token = monitor
        monitor = nil
        installed = false
        lock.unlock()
        if let token {
            NSEvent.removeMonitor(token)
        }
    }

    /// Internal hook used by the `NSEvent` callback. Resolves the hit element
    /// from the source window's content view, runs the decider, and *defers*
    /// the actual emit via ``OptelClickCoordinator`` so any refined handler
    /// (`.optelTap`, ``OptelButton``) that fires during the same event
    /// dispatch can claim the click and suppress this global emission.
    /// Never throws and never returns a value: the caller's `return event`
    /// keeps the click flowing to the responder chain.
    static func handle(event: NSEvent) {
        guard let window = event.window ?? NSApplication.shared.keyWindow,
            let contentView = window.contentView else {
            return
        }
        // `hitTest(_:)` expects the point in the receiver's *superview*
        // coordinates; for the content view that superview is the window, so
        // `event.locationInWindow` is already in the right space.
        let hit = contentView.hitTest(event.locationInWindow)
        let decision = OptelClickEmitDecider.decide(for: hit)
        guard decision.shouldEmit else { return }
        // Allocate an epoch for this monitor event; refined SwiftUI handlers
        // that run during the synchronous event dispatch can claim it. We
        // schedule the emit via `DispatchQueue.main.async` so the deferred
        // block runs after the responder chain (and therefore after any
        // refined claim) has finished processing the event.
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        DispatchQueue.main.async {
            OptelClickMonitor.deferredEmit(
                epoch: epoch,
                source: decision.source,
                target: decision.target
            )
        }
    }

    /// Testable seam mirroring the body of the monitor's deferred async
    /// block. Emits `click` only when the supplied epoch was *not* claimed
    /// by a refined handler since ``handle(event:)`` scheduled it.
    static func deferredEmit(epoch: UInt64, source: String?, target: String?) {
        guard !OptelClickCoordinator.wasClaimedByRefined(epoch: epoch) else { return }
        Optel.sample(.click, source: source, target: target)
    }

    /// Test-only reset of the install latch and any registered monitor.
    internal static func _testing_reset() {
        uninstall()
    }
}
#endif
