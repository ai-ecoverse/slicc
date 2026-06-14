import Foundation

/// Builds the `source` selector string carried on RUM beacons.
///
/// Mirrors the helix-rum-enhancer convention of `<context> <element>#<identifier>`
/// (e.g. `"main button#submit"`), adapted for native UI hierarchies where the
/// only signals available are accessibility identifier / label and an optional
/// parent context (typically the view name).
///
/// Pure value type with no SwiftUI dependency so it can be unit-tested on every
/// platform.
public enum OptelSourceDeriver {
    /// Compose a source selector from the parts a native UI control can supply.
    ///
    /// - Parameters:
    ///   - element: The element class (e.g. `"button"`, `"view"`). Required —
    ///     anchors the selector even when nothing else is known.
    ///   - identifier: Accessibility identifier. Rendered as `#identifier`.
    ///   - label: Accessibility / visible label. Rendered as `"label"` when no
    ///     identifier is available.
    ///   - context: Optional parent context (e.g. owning view name). Rendered
    ///     as a leading token separated by a space.
    public static func source(
        element: String,
        identifier: String? = nil,
        label: String? = nil,
        context: String? = nil
    ) -> String {
        let trimmedElement = trimmed(element) ?? "view"
        let trimmedIdentifier = trimmed(identifier)
        let trimmedLabel = trimmed(label)
        let trimmedContext = trimmed(context)

        let core: String
        if let identifier = trimmedIdentifier {
            core = "\(trimmedElement)#\(identifier)"
        } else if let label = trimmedLabel {
            core = "\(trimmedElement) \"\(label)\""
        } else {
            core = trimmedElement
        }

        if let context = trimmedContext {
            return "\(context) \(core)"
        }
        return core
    }

    /// Trim whitespace and return `nil` for empty / whitespace-only inputs.
    private static func trimmed(_ value: String?) -> String? {
        guard let value else { return nil }
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? nil : result
    }
}
