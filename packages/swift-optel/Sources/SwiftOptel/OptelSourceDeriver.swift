import Foundation

public enum OptelSourceDeriver {

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

    private static func trimmed(_ value: String?) -> String? {
        guard let value else { return nil }
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? nil : result
    }
}
