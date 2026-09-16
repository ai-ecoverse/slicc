#if os(macOS)
    import Foundation
    #if canImport(AppKit)
        import AppKit
    #endif

    public protocol OptelAccessibleElement {

        var optelAccessibilityRole: String? { get }

        var optelAccessibilityIdentifier: String? { get }

        var optelAccessibilityLabel: String? { get }

        var optelAccessibilityWindowTitle: String? { get }

        var optelAccessibilityParent: OptelAccessibleElement? { get }
    }

    public enum OptelAccessibilityDeriver {

        public static let maxAncestorDepth = 64

        public struct Derived: Equatable, Sendable {
            public let source: String
            public let target: String?

            public init(source: String, target: String?) {
                self.source = source
                self.target = target
            }
        }

        public static func derive(from element: OptelAccessibleElement) -> Derived {
            let resolved = nearestMeaningful(from: element) ?? element
            let windowTitle = walkForWindowTitle(from: element)
            let role = nonEmpty(resolved.optelAccessibilityRole) ?? "view"
            let identifier = nonEmpty(resolved.optelAccessibilityIdentifier)
            let label = nonEmpty(resolved.optelAccessibilityLabel)
            let source = OptelSourceDeriver.source(
                element: role,
                identifier: identifier,
                label: label,
                context: windowTitle
            )
            return Derived(source: source, target: label)
        }

        static let genericRoles: Set<String> = [
            "AXUnknown", "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea",
            "AXLayoutItem", "AXGenericElement",
            "unknown", "group", "splitGroup", "scrollArea", "layoutArea",
        ]

        static func isMeaningful(_ element: OptelAccessibleElement) -> Bool {
            if nonEmpty(element.optelAccessibilityIdentifier) != nil { return true }
            if nonEmpty(element.optelAccessibilityLabel) != nil { return true }
            if let role = nonEmpty(element.optelAccessibilityRole),
                !genericRoles.contains(role)
            {
                return true
            }
            return false
        }

        static func nearestMeaningful(from element: OptelAccessibleElement) -> OptelAccessibleElement? {
            var current: OptelAccessibleElement? = element
            var depth = 0
            while let node = current, depth < maxAncestorDepth {
                if isMeaningful(node) { return node }
                current = node.optelAccessibilityParent
                depth += 1
            }
            return nil
        }

        static func walkForWindowTitle(from element: OptelAccessibleElement) -> String? {
            var current: OptelAccessibleElement? = element
            var depth = 0
            while let node = current, depth < maxAncestorDepth {
                if let title = nonEmpty(node.optelAccessibilityWindowTitle) {
                    return title
                }
                current = node.optelAccessibilityParent
                depth += 1
            }
            return nil
        }

        static func nonEmpty(_ value: String?) -> String? {
            guard let value else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    #if canImport(AppKit)

        extension NSView: OptelAccessibleElement {
            public var optelAccessibilityRole: String? { accessibilityRole()?.rawValue }
            public var optelAccessibilityIdentifier: String? { accessibilityIdentifier() }
            public var optelAccessibilityLabel: String? {
                let label = accessibilityLabel()
                if let label, !label.isEmpty { return label }
                return accessibilityTitle()
            }
            public var optelAccessibilityWindowTitle: String? { window?.title }
            public var optelAccessibilityParent: OptelAccessibleElement? { superview }
        }
    #endif
#endif
