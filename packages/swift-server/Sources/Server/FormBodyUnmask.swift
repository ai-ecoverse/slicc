import Foundation





















private let formComponentAllowed = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
)




private func decodeFormComponent(_ raw: String) -> String? {
    raw.replacingOccurrences(of: "+", with: "%20").removingPercentEncoding
}



private func encodeFormComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: formComponentAllowed) ?? value
}



func unmaskFormBody(text body: String, hostname: String, injector: SecretInjector) -> String {
    if body.isEmpty || injector.isEmpty { return body }

    var changed = false
    let fields = body.components(separatedBy: "&").map { field -> String in
        let name: String
        let rawValue: String
        if let eq = field.firstIndex(of: "=") {
            name = String(field[field.startIndex...eq])
            rawValue = String(field[field.index(after: eq)...])
        } else {
            name = ""
            rawValue = field
        }
        if rawValue.isEmpty { return field }

        guard let decoded = decodeFormComponent(rawValue) else {
            
            
            
            
            let replaced = injector.injectBody(text: rawValue, hostname: hostname)
            if replaced == rawValue { return field }
            changed = true
            return name + replaced
        }

        let replaced = injector.injectBody(text: decoded, hostname: hostname)
        if replaced == decoded { return field }
        changed = true
        return name + encodeFormComponent(replaced)
    }

    return changed ? fields.joined(separator: "&") : body
}
