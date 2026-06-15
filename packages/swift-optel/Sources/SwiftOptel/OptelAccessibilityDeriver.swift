#if os(macOS)
import Foundation
#if canImport(AppKit)
import AppKit
#endif

/// Minimal description of an accessibility element used to derive a RUM
/// `source` / `target` pair without touching live AppKit objects.
///
/// AppKit types (`NSView`, accessibility proxies) adopt this protocol; tests
/// supply pure value-type fakes so ``OptelAccessibilityDeriver`` can be
/// exercised without a running app.
public protocol OptelAccessibleElement {
    /// Accessibility role (e.g. `AXButton`, `button`). Empty / whitespace
    /// values are treated as absent.
    var optelAccessibilityRole: String? { get }
    /// Accessibility identifier (the AppKit analogue of an HTML `id`).
    var optelAccessibilityIdentifier: String? { get }
    /// Human-readable accessibility label / title.
    var optelAccessibilityLabel: String? { get }
    /// Title of the window that owns this element, if any.
    var optelAccessibilityWindowTitle: String? { get }
    /// Next element walking toward the window root (typically the superview).
    var optelAccessibilityParent: OptelAccessibleElement? { get }
}

/// Walks from a hit element up its ancestor chain to the nearest meaningfully
/// accessible control and composes a RUM `source` / `target` pair via
/// ``OptelSourceDeriver``.
///
/// `source` follows the existing `<context> <element>#<identifier>` shape,
/// using the resolved control's role as `element`, its identifier / label as
/// the disambiguator, and the owning window's title as `context`. `target`
/// is the human label (preferred) or title when nothing better is available.
public enum OptelAccessibilityDeriver {
    /// Maximum ancestors walked. Guards against pathological / cyclic chains
    /// without imposing a meaningful limit on real UI hierarchies.
    public static let maxAncestorDepth = 64

    /// Resolved `source` / `target` pair for an `click` (or similar) checkpoint.
    public struct Derived: Equatable, Sendable {
        public let source: String
        public let target: String?

        public init(source: String, target: String?) {
            self.source = source
            self.target = target
        }
    }

    /// Derive the RUM pair from `element`. Walks ancestors until a
    /// meaningfully-accessible node is found (identifier, label, or a
    /// non-generic role); falls back to the hit element itself when nothing
    /// upstream qualifies.
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

    /// Roles that describe layout containers rather than interactive controls;
    /// the deriver walks through these looking for something meaningful.
    static let genericRoles: Set<String> = [
        "AXUnknown", "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea",
        "AXLayoutItem", "AXGenericElement",
        "unknown", "group", "splitGroup", "scrollArea", "layoutArea",
    ]

    static func isMeaningful(_ element: OptelAccessibleElement) -> Bool {
        if nonEmpty(element.optelAccessibilityIdentifier) != nil { return true }
        if nonEmpty(element.optelAccessibilityLabel) != nil { return true }
        if let role = nonEmpty(element.optelAccessibilityRole),
           !genericRoles.contains(role) {
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
/// AppKit adapter: any `NSView` can be passed to ``OptelAccessibilityDeriver``
/// directly. Reads the standard NSAccessibility role / identifier / label
/// values and walks the superview chain.
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
