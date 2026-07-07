import Foundation
import AppUpdater
import Version

/// A custom `ReleaseProvider` that uses tolerant version decoding so that
/// GitHub release tags prefixed with "v" (e.g. "v1.36.0") are accepted.
///
/// The default `GithubReleaseProvider` uses strict `Version` decoding which
/// rejects the "v" prefix. Setting `DecodingMethod.tolerant` in the decoder's
/// `userInfo` causes `Version.init?(tolerant:)` to be used instead, which
/// strips the prefix before parsing.
///
/// If a `GH_TOKEN` environment variable is set, the request is authenticated
/// with `Authorization: Bearer <token>`. GitHub's unauthenticated API limit
/// is 60 requests/hour per IP and is hit easily by users behind corporate
/// NAT or shared CI runners; an authenticated request gets 5,000/hour. The
/// provider falls back to anonymous requests when no token is present so
/// regular users — who do not need to set anything — keep working.
struct TolerantGithubReleaseProvider: ReleaseProvider {
    private let github = GithubReleaseProvider()
    private let authToken: String?
    private let host: UpdateHostConfiguration
    private let releasePrefix: String

    init(
        authToken: String? = nil,
        host: UpdateHostConfiguration = UpdateHostConfiguration.resolve(),
        releasePrefix: String = "Sliccstart"
    ) {
        // Treat an empty `GH_TOKEN` (e.g. `export GH_TOKEN=` from a script
        // that forgot to populate it) as no token. Otherwise we would emit
        // `Authorization: Bearer ` and GitHub would 401 with a misleading
        // `URLError(.badServerResponse)` at the call site.
        let resolved = authToken ?? ProcessInfo.processInfo.environment["GH_TOKEN"]
        self.authToken = resolved.flatMap { $0.isEmpty ? nil : $0 }
        self.host = host
        self.releasePrefix = releasePrefix
    }

    func fetchReleases(owner: String, repo: String, proxy: URLRequestProxy?) async throws -> [Release] {
        let url = host.releasesURL(owner: owner, repo: repo)
        var request = URLRequest(url: url)
        if let authToken {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        request = request.applyOrOriginal(proxy: proxy)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let decoder = JSONDecoder()
        decoder.userInfo[.decodingMethod] = DecodingMethod.tolerant
        let releases = try decoder.decode([Release].self, from: data)
        // Drop releases that carry no macOS asset AppUpdater can install, so
        // `findViableUpdate` falls back to the newest release that actually
        // ships a `Sliccstart-<version>.zip` instead of throwing on the newest
        // (possibly binary-less) tag. `AppUpdater.Release.viableAsset` is
        // internal to the module and cannot be called from here, so we
        // replicate its predicate exactly below.
        return filterViableReleases(releases)
    }

    /// Keeps only releases that ship an installable macOS asset. Exposed at
    /// internal visibility so tests can exercise the predicate against decoded
    /// JSON fixtures without a network round-trip.
    func filterViableReleases(_ releases: [Release]) -> [Release] {
        releases.filter { hasViableMacOSAsset($0) }
    }

    /// Replicates `AppUpdater.Release.viableAsset(forRelease:)` (internal to
    /// the AppUpdater module, hence not callable): a release is kept when any
    /// asset is either `<prefix>-<tagName>.zip` (content type zip) or the
    /// `<prefix>-<tagName>.tar` tar variant, using the parsed `tagName`
    /// exactly as AppUpdater does.
    private func hasViableMacOSAsset(_ release: Release) -> Bool {
        let prefix = "\(releasePrefix.lowercased())-\(release.tagName)"
        return release.assets.contains { asset in
            let name = (asset.name as NSString).deletingPathExtension.lowercased()
            let fileExtension = (asset.name as NSString).pathExtension
            switch (name, asset.contentTyle, fileExtension) {
            case ("\(prefix).tar", .tar, "tar"):
                return true
            case (prefix, .zip, "zip"):
                return true
            default:
                return false
            }
        }
    }

    func download(asset: Release.Asset, to saveLocation: URL, proxy: URLRequestProxy?) async throws -> AsyncThrowingStream<DownloadingState, Error> {
        try await github.download(asset: asset, to: saveLocation, proxy: proxy)
    }

    func fetchAssetData(asset: Release.Asset, proxy: URLRequestProxy?) async throws -> Data {
        try await github.fetchAssetData(asset: asset, proxy: proxy)
    }
}
