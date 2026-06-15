import Foundation

/// Identity + display source for a window candidate, in a form that does not
/// depend on AppKit so the dedupe logic can be unit-tested on every platform.
///
/// `key` is the stable identity used to decide "same window vs. different
/// window" — re-focusing the same window must not emit `navigate`. `source` is
/// the human-facing string carried as the beacon's `source` field; preferring
/// the window title when available falls back to the accessibility identifier.
public struct OptelWindowIdentity: Equatable, Hashable, Sendable {
    public let key: String
    public let source: String

    public init(key: String, source: String) {
        self.key = key
        self.source = source
    }

    /// Compose an identity from the raw bits AppKit gives us on macOS. Exposed
    /// at module scope so tests can synthesize identities without an `NSWindow`.
    ///
    /// - Parameters:
    ///   - identifier: `NSWindow.identifier?.rawValue` (or `nil`).
    ///   - title: `NSWindow.title` (may be empty).
    ///   - fallbackKey: Stable per-window fallback (e.g. `ObjectIdentifier`
    ///     hash) used when both identifier and title are blank. Required so
    ///     two distinct, equally-blank windows are not collapsed into one.
    public static func make(
        identifier: String?,
        title: String?,
        fallbackKey: String
    ) -> OptelWindowIdentity {
        let trimmedID = identifier?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let key: String
        if !trimmedID.isEmpty {
            key = "id:\(trimmedID)"
        } else if !trimmedTitle.isEmpty {
            key = "title:\(trimmedTitle)"
        } else {
            key = "ref:\(fallbackKey)"
        }

        let source: String
        if !trimmedTitle.isEmpty {
            source = trimmedTitle
        } else if !trimmedID.isEmpty {
            source = trimmedID
        } else {
            source = "window"
        }

        return OptelWindowIdentity(key: key, source: source)
    }
}

/// Pure decision for "should this key/main change emit a `navigate` beacon?".
///
/// The macOS observer is intentionally a thin shell around this enum so the
/// dedupe rules are exercised by ordinary unit tests rather than by driving a
/// live `NSApplication` event loop.
public enum OptelWindowNavigateDecider {
    public struct Decision: Equatable, Sendable {
        public let shouldEmit: Bool
        public let source: String?

        public init(shouldEmit: Bool, source: String?) {
            self.shouldEmit = shouldEmit
            self.source = source
        }
    }

    /// Decide whether to emit `navigate` given the previously-seen identity
    /// (or `nil` for the first observation) and the newly-focused identity.
    public static func decide(
        previous: OptelWindowIdentity?,
        current: OptelWindowIdentity
    ) -> Decision {
        if let previous, previous.key == current.key {
            return Decision(shouldEmit: false, source: nil)
        }
        return Decision(shouldEmit: true, source: current.source)
    }
}

#if os(macOS)
import AppKit

/// macOS-only observer that watches for key/main window changes and emits
/// `navigate` beacons whenever focus moves to a *different* window.
///
/// Install/uninstall is idempotent; the dedupe state is reset on uninstall so
/// the next install starts fresh. The actual emit/skip decision is delegated
/// to ``OptelWindowNavigateDecider`` so the behavior is unit-tested in pure
/// Swift without requiring a running app.
public enum OptelWindowObserver {
    private static let lock = NSLock()
    private static var installed = false
    private static var observers: [NSObjectProtocol] = []
    private static var lastIdentity: OptelWindowIdentity?

    /// `true` once the observer has been installed for this process.
    public static var isInstalled: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    /// Install observers for `NSWindow.didBecomeKeyNotification` and
    /// `didBecomeMainNotification`. Safe to call repeatedly; the second and
    /// subsequent calls are no-ops.
    public static func installIfNeeded() {
        lock.lock()
        guard !installed else {
            lock.unlock()
            return
        }
        installed = true
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification,
            NSWindow.didBecomeMainNotification,
        ]
        for name in names {
            let token = center.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { notification in
                guard let window = notification.object as? NSWindow else { return }
                OptelWindowObserver.handle(window: window)
            }
            observers.append(token)
        }
        lock.unlock()
    }

    /// Remove the installed observers and reset dedupe state. Safe to call
    /// when nothing is installed.
    public static func uninstall() {
        lock.lock()
        let toRemove = observers
        observers.removeAll()
        lastIdentity = nil
        installed = false
        lock.unlock()
        let center = NotificationCenter.default
        for token in toRemove {
            center.removeObserver(token)
        }
    }

    /// Internal hook used by the notification handlers. Runs the identity +
    /// decider seam against the supplied window and emits when appropriate.
    static func handle(window: NSWindow) {
        let identity = identity(for: window)
        let decision: OptelWindowNavigateDecider.Decision
        lock.lock()
        decision = OptelWindowNavigateDecider.decide(
            previous: lastIdentity,
            current: identity
        )
        lastIdentity = identity
        lock.unlock()
        if decision.shouldEmit, let source = decision.source {
            Optel.sample(.navigate, source: source)
        }
    }

    /// Build an ``OptelWindowIdentity`` for an `NSWindow`. Extracted so tests
    /// can construct equivalent identities without instantiating AppKit.
    static func identity(for window: NSWindow) -> OptelWindowIdentity {
        OptelWindowIdentity.make(
            identifier: window.identifier?.rawValue,
            title: window.title,
            fallbackKey: String(ObjectIdentifier(window).hashValue)
        )
    }

    /// Test-only reset of the install latch and dedupe state. Removes any
    /// currently-registered notification observers.
    internal static func _testing_reset() {
        uninstall()
    }
}
#endif
