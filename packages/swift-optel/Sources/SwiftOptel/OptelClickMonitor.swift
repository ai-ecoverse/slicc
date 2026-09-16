#if os(macOS)
    import Foundation
    import AppKit

    public enum OptelClickEmitDecider {

        public static let ignoreIdentifier = "optel-ignore"

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

        public static let skip = Decision(shouldEmit: false, source: nil, target: nil)

        public static func decide(for element: OptelAccessibleElement?) -> Decision {
            guard let element else { return skip }
            if hasIgnoreMarker(in: element) { return skip }
            let derived = OptelAccessibilityDeriver.derive(from: element)
            return Decision(shouldEmit: true, source: derived.source, target: derived.target)
        }

        static func hasIgnoreMarker(in element: OptelAccessibleElement) -> Bool {
            var current: OptelAccessibleElement? = element
            var depth = 0
            while let node = current, depth < OptelAccessibilityDeriver.maxAncestorDepth {
                if let identifier = node.optelAccessibilityIdentifier?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                    identifier == ignoreIdentifier
                {
                    return true
                }
                current = node.optelAccessibilityParent
                depth += 1
            }
            return false
        }
    }

    public enum OptelClickMonitor {
        private static let lock = NSLock()
        private static var installed = false
        private static var monitor: Any?

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
            let token = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { event in
                OptelClickMonitor.handle(event: event)
                return event
            }
            monitor = token
            lock.unlock()
        }

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

        static func handle(event: NSEvent) {
            guard let window = event.window ?? NSApplication.shared.keyWindow,
                let contentView = window.contentView
            else {
                return
            }

            let hit = contentView.hitTest(event.locationInWindow)
            let decision = OptelClickEmitDecider.decide(for: hit)
            guard decision.shouldEmit else { return }

            let epoch = OptelClickCoordinator.beginMonitorEvent()
            DispatchQueue.main.async {
                OptelClickMonitor.deferredEmit(
                    epoch: epoch,
                    source: decision.source,
                    target: decision.target
                )
            }
        }

        static func deferredEmit(epoch: UInt64, source: String?, target: String?) {
            guard !OptelClickCoordinator.wasClaimedByRefined(epoch: epoch) else { return }
            Optel.sample(.click, source: source, target: target)
        }

        internal static func _testing_reset() {
            uninstall()
        }
    }
#endif
