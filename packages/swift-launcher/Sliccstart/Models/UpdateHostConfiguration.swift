import Foundation


















struct UpdateHostConfiguration: Equatable {
    let baseURL: URL

    static let productionBaseURL = URL(string: "https://api.github.com")!

    static func resolve(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> UpdateHostConfiguration {
        if let fromArgs = parseArgumentHost(arguments: arguments) {
            return UpdateHostConfiguration(baseURL: fromArgs)
        }
        if let raw = environment["SLICC_UPDATE_HOST"], !raw.isEmpty, let url = URL(string: raw) {
            return UpdateHostConfiguration(baseURL: url)
        }
        return UpdateHostConfiguration(baseURL: productionBaseURL)
    }

    private static func parseArgumentHost(arguments: [String]) -> URL? {
        for (index, arg) in arguments.enumerated() {
            if arg.hasPrefix("--update-host=") {
                let raw = String(arg.dropFirst("--update-host=".count))
                if let url = URL(string: raw), !raw.isEmpty { return url }
            }
            if arg == "--update-host", index + 1 < arguments.count {
                let raw = arguments[index + 1]
                if let url = URL(string: raw), !raw.isEmpty { return url }
            }
        }
        return nil
    }

    
    func releasesURL(owner: String, repo: String) -> URL {
        baseURL.appendingPathComponent("repos/\(owner)/\(repo)/releases")
    }
}
