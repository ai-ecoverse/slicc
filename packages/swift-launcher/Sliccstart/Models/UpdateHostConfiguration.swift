import Foundation

/// Resolves the base URL used by Sliccstart's update machinery. In
/// production this is GitHub's API host; in tests (and for hand-driven
/// repro) the launcher accepts either:
///
/// * `--update-host=<url>` on the command line, or
/// * `SLICC_UPDATE_HOST=<url>` in the environment.
///
/// The override is applied uniformly to:
///
/// * The `releases` listing endpoint (`<host>/repos/<owner>/<repo>/releases`).
/// * Any asset whose `browser_download_url` is already on the same host —
///   no rewriting is performed, because the fake server returns
///   self-consistent JSON with localhost asset URLs of its own.
///
/// Resolved once at launch and treated as immutable for the rest of the
/// process so checking-for-updates and applying-an-update can't disagree
/// about which server they're talking to.
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

    /// Build the URL for the releases-listing endpoint.
    func releasesURL(owner: String, repo: String) -> URL {
        baseURL.appendingPathComponent("repos/\(owner)/\(repo)/releases")
    }
}
