import Foundation






















func isTextContentType(_ contentType: String) -> Bool {
    if contentType.isEmpty { return false }
    let normalized = contentType.lowercased()
    return normalized.hasPrefix("text/")
        || normalized.contains("json")
        || normalized.contains("xml")
        || normalized.contains("javascript")
        || normalized.contains("ecmascript")
        || normalized.contains("html")
        || normalized.contains("css")
        || normalized.contains("svg")
}






func isFormContentType(_ contentType: String) -> Bool {
    if contentType.isEmpty { return false }
    return contentType.lowercased().contains("urlencoded")
}




















func isTextRequestContentType(_ contentType: String) -> Bool {
    if contentType.isEmpty { return false }
    return isTextContentType(contentType) || isFormContentType(contentType)
}
