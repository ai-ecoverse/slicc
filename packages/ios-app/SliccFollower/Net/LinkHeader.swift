import Foundation














struct ParsedLink: Equatable {
    
    let href: String
    
    let rel: [String]
    
    let params: [String: String]

    var title: String? { params["title"] }
}

enum LinkHeader {
    
    
    
    
    
    static func parse(_ values: [String], baseURL: String? = nil) -> [ParsedLink] {
        parse(values.joined(separator: ", "), baseURL: baseURL)
    }

    static func parse(_ value: String, baseURL: String? = nil) -> [ParsedLink] {
        let normalized = value.replacingOccurrences(of: "\n", with: ", ")
        if normalized.isEmpty { return [] }

        let chars = Array(normalized)
        var out: [ParsedLink] = []
        var i = 0

        while i < chars.count {
            i = skipOWS(chars, i)
            if i >= chars.count { break }
            guard chars[i] == "<" else {
                i = skipToNextValue(chars, i)
                continue
            }
            guard let uriEnd = indexOf(chars, ">", from: i + 1) else { break }
            let rawURI = String(chars[(i + 1)..<uriEnd])
            i = uriEnd + 1

            var rawParams: [(String, String)] = []
            (i, rawParams) = readParams(chars, from: i)

            if let link = buildLink(rawURI: rawURI, rawParams: rawParams, baseURL: baseURL) {
                out.append(link)
            }
        }
        return out
    }

    

    
    
    private static func readParams(
        _ chars: [Character], from start: Int
    ) -> (Int, [(String, String)]) {
        var i = start
        var rawParams: [(String, String)] = []
        while i < chars.count {
            i = skipOWS(chars, i)
            if i >= chars.count { break }
            if chars[i] == "," {
                i += 1
                break
            }
            guard chars[i] == ";" else {
                i = skipToNextValue(chars, i)
                break
            }
            i += 1
            i = skipOWS(chars, i)

            let nameStart = i
            while i < chars.count, isTokenChar(chars[i]) { i += 1 }
            
            if i < chars.count, chars[i] == "*" { i += 1 }
            if nameStart == i {
                i = skipToNextValue(chars, i)
                break
            }
            let name = String(chars[nameStart..<i]).lowercased()

            i = skipOWS(chars, i)
            var value = ""
            if i < chars.count, chars[i] == "=" {
                i += 1
                i = skipOWS(chars, i)
                if i < chars.count, chars[i] == "\"" {
                    let read = readQuotedString(chars, i)
                    value = read.value
                    i = read.end
                } else {
                    let valueStart = i
                    while i < chars.count, chars[i] != ";", chars[i] != ",", !isOWSChar(chars[i]) {
                        i += 1
                    }
                    value = String(chars[valueStart..<i])
                }
            }
            rawParams.append((name, value))
        }
        return (i, rawParams)
    }

    private static func indexOf(_ chars: [Character], _ needle: Character, from: Int) -> Int? {
        var i = from
        while i < chars.count {
            if chars[i] == needle { return i }
            i += 1
        }
        return nil
    }

    private static func skipOWS(_ chars: [Character], _ start: Int) -> Int {
        var i = start
        while i < chars.count, isOWSChar(chars[i]) { i += 1 }
        return i
    }

    private static func isOWSChar(_ c: Character) -> Bool { c == " " || c == "\t" }

    
    
    private static func skipToNextValue(_ chars: [Character], _ start: Int) -> Int {
        var i = start
        var inQuote = false
        while i < chars.count {
            let c = chars[i]
            if inQuote {
                if c == "\\", i + 1 < chars.count {
                    i += 2
                    continue
                }
                if c == "\"" { inQuote = false }
            } else if c == "\"" {
                inQuote = true
            } else if c == "," {
                return i + 1
            }
            i += 1
        }
        return i
    }

    private static func readQuotedString(
        _ chars: [Character], _ start: Int
    ) -> (value: String, end: Int) {
        var i = start + 1  
        var result = ""
        while i < chars.count {
            let c = chars[i]
            if c == "\\" {
                i += 1
                if i < chars.count {
                    result.append(chars[i])
                    i += 1
                }
            } else if c == "\"" {
                return (result, i + 1)
            } else {
                result.append(c)
                i += 1
            }
        }
        return (result, i)
    }

    
    private static func isTokenChar(_ c: Character) -> Bool {
        guard let ascii = c.asciiValue else { return false }
        switch ascii {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A:
            return true
        case 0x21, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2A, 0x2B, 0x2D, 0x2E, 0x5E, 0x5F, 0x60, 0x7C,
            0x7E:
            return true
        default:
            return false
        }
    }

    

    private static func buildLink(
        rawURI: String, rawParams: [(String, String)], baseURL: String?
    ) -> ParsedLink? {
        var params: [String: String] = [:]
        var extOverrides: [String: String] = [:]

        for (name, value) in rawParams {
            if name.hasSuffix("*") {
                if let decoded = decodeExtValue(value) {
                    extOverrides[String(name.dropLast())] = decoded
                }
                continue
            }
            
            if name == "rel", params["rel"] != nil { continue }
            params[name] = value
        }
        
        for (name, value) in extOverrides { params[name] = value }

        let href = resolveURI(rawURI, baseURL: baseURL)
        let rel = (params["rel"] ?? "")
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
            .map(String.init)
        return ParsedLink(href: href, rel: rel, params: params)
    }

    private static func resolveURI(_ ref: String, baseURL: String?) -> String {
        guard let baseURL, let base = URL(string: baseURL) else { return ref }
        
        if ref.isEmpty { return base.absoluteString }
        guard let resolved = URL(string: ref, relativeTo: base) else { return ref }
        return resolved.absoluteURL.absoluteString
    }

    
    
    
    static func decodeExtValue(_ value: String) -> String? {
        guard let firstQuote = value.firstIndex(of: "'") else { return nil }
        let afterFirst = value.index(after: firstQuote)
        guard afterFirst <= value.endIndex,
            let secondQuote = value[afterFirst...].firstIndex(of: "'")
        else { return nil }
        guard value[value.startIndex..<firstQuote].lowercased() == "utf-8" else { return nil }
        let encoded = String(value[value.index(after: secondQuote)...])
        return encoded.removingPercentEncoding
    }
}
