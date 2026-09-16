import Foundation

public struct OptelWindowIdentity: Equatable, Hashable, Sendable {
    public let key: String
    public let source: String

    public init(key: String, source: String) {
        self.key = key
        self.source = source
    }

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

            key = "title:\(trimmedTitle)#ref:\(fallbackKey)"
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

public enum OptelWindowNavigateDecider {
    public struct Decision: Equatable, Sendable {
        public let shouldEmit: Bool
        public let source: String?

        public init(shouldEmit: Bool, source: String?) {
            self.shouldEmit = shouldEmit
            self.source = source
        }
    }

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

    public enum OptelWindowObserver {
        private static let lock = NSLock()
        private static var installed = false
        private static var observers: [NSObjectProtocol] = []
        private static var lastIdentity: OptelWindowIdentity?

        public static var isInstalled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return installed
        }

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

        static func identity(for window: NSWindow) -> OptelWindowIdentity {
            OptelWindowIdentity.make(
                identifier: window.identifier?.rawValue,
                title: window.title,
                fallbackKey: String(ObjectIdentifier(window).hashValue)
            )
        }

        internal static func _testing_reset() {
            uninstall()
        }
    }
#endif
