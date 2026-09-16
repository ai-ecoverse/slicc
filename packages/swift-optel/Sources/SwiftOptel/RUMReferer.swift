import Foundation

public enum RUMReferer {

    public static let defaultCollectBaseURL = URL(string: "https://rum.hlx.page/")!

    public static func build(appID: String, viewPath: String = "/") -> String {
        let normalized: String
        if viewPath.isEmpty {
            normalized = "/"
        } else if viewPath.hasPrefix("/") {
            normalized = viewPath
        } else {
            normalized = "/" + viewPath
        }
        return "https://\(appID)\(normalized)"
    }
}
