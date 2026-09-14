import Foundation
























public enum SupersedeLink {
    
    public static let rel = "successor-version"

    
    
    
    
    
    public static func successor(in header: String?) -> URL? {
        guard let header, !header.isEmpty else { return nil }
        
        let merged = header.replacingOccurrences(of: "\n", with: ", ")
        for value in splitOutsideQuotes(merged, separator: ",") {
            guard value.hasPrefix("<"), let uriEnd = value.firstIndex(of: ">") else { continue }
            let params = String(value[value.index(after: uriEnd)...])
            guard hasSuccessorRel(params) else { continue }
            let target = String(value[value.index(after: value.startIndex)..<uriEnd])
                .trimmingCharacters(in: .whitespaces)
            guard let url = URL(string: target), url.scheme != nil, url.host != nil else {
                return nil
            }
            return url
        }
        return nil
    }

    
    public static func successor(in response: HTTPURLResponse) -> URL? {
        successor(in: response.value(forHTTPHeaderField: "Link"))
    }

    
    
    
    
    
    
    
    
    
    public static func redirectTarget(in response: HTTPURLResponse) -> URL? {
        guard (300..<400).contains(response.statusCode),
            let raw = response.value(forHTTPHeaderField: "Location"),
            var components = URLComponents(string: raw),
            components.scheme != nil, components.host != nil
        else { return nil }
        let remaining = (components.queryItems ?? []).filter { $0.name != "json" }
        components.queryItems = remaining.isEmpty ? nil : remaining
        return components.url
    }

    
    
    
    
    private static func splitOutsideQuotes(_ input: String, separator: Character) -> [String] {
        var out: [String] = []
        var current = ""
        var inQuotes = false
        var inAngle = false
        var escaped = false
        for ch in input {
            if inQuotes {
                current.append(ch)
                if escaped {
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else if ch == "\"" {
                    inQuotes = false
                }
                continue
            }
            switch ch {
            case "\"": inQuotes = true
            case "<": inAngle = true
            case ">": inAngle = false
            default: break
            }
            if ch == separator && !inAngle {
                out.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
                continue
            }
            current.append(ch)
        }
        out.append(current.trimmingCharacters(in: .whitespaces))
        return out.filter { !$0.isEmpty }
    }

    
    private static func hasSuccessorRel(_ params: String) -> Bool {
        for param in splitOutsideQuotes(params, separator: ";") {
            guard let eq = param.firstIndex(of: "=") else { continue }
            let name = param[..<eq].trimmingCharacters(in: .whitespaces)
            guard name.lowercased() == "rel" else { continue }
            var value = String(param[param.index(after: eq)...])
                .trimmingCharacters(in: .whitespaces)
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
                value = String(value.dropFirst().dropLast())
            }
            
            
            if value.split(whereSeparator: { $0.isWhitespace })
                .contains(where: { $0.lowercased() == rel })
            {
                return true
            }
        }
        return false
    }
}
