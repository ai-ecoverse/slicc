import AppUpdater
import Foundation
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
    /// Transport seam: returns the response body plus the HTTP response so
    /// pagination can read the `Link` header. Injected by tests.
    typealias PageFetcher = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

    /// GitHub's maximum page size for the releases listing.
    static let releasesPerPage = 100

    /// Loop guard, not the intended stopping point: the walk normally ends at
    /// the running build's own release (see `fetchReleases`). This only bounds
    /// a host whose `Link` chain never terminates or whose tags never reach
    /// `currentVersion`.
    static let maxReleasePages = 20

    private let github = GithubReleaseProvider()
    private let authToken: String?
    private let host: UpdateHostConfiguration
    private let releasePrefix: String
    private let currentVersion: Version
    private let fetchPage: PageFetcher

    init(
        authToken: String? = nil,
        host: UpdateHostConfiguration = UpdateHostConfiguration.resolve(),
        releasePrefix: String = "Sliccstart",
        currentVersion: Version = Bundle.main.version,
        fetchPage: PageFetcher? = nil
    ) {
        // Treat an empty `GH_TOKEN` (e.g. `export GH_TOKEN=` from a script
        // that forgot to populate it) as no token. Otherwise we would emit
        // `Authorization: Bearer ` and GitHub would 401 with a misleading
        // `URLError(.badServerResponse)` at the call site.
        let resolved = authToken ?? ProcessInfo.processInfo.environment["GH_TOKEN"]
        self.authToken = resolved.flatMap { $0.isEmpty ? nil : $0 }
        self.host = host
        self.releasePrefix = releasePrefix
        self.currentVersion = currentVersion
        self.fetchPage = fetchPage ?? Self.urlSessionFetchPage
    }

    /// Walks the releases listing newest-first and returns the installable
    /// releases from the first page that contains at least one. A single page
    /// is not enough: releases ship roughly ten times a day while the macOS
    /// launcher artifact is built only when `packages/swift-launcher/**`
    /// changes, so the newest `Sliccstart-<version>.zip` regularly sits far
    /// behind the newest tag. Stopping at page one made `findViableUpdate`
    /// see an empty list and report "no update" while a newer installable
    /// release existed.
    ///
    /// The walk stops once a page reaches `currentVersion` — the release the
    /// running build came from. Anything past it is older than what is
    /// installed and can never be an update, so that is the natural end of the
    /// search rather than an arbitrary page count. See `hasReached(_:)` for why
    /// "reached" is not simply "saw an older tag".
    func fetchReleases(owner: String, repo: String, proxy: URLRequestProxy?) async throws -> [Release] {
        var nextURL: URL? = Self.firstPageURL(host.releasesURL(owner: owner, repo: repo))
        var viable: [Release] = []
        var pagesFetched = 0
        var reachedCurrentVersion = false

        while let url = nextURL, viable.isEmpty, !reachedCurrentVersion, pagesFetched < Self.maxReleasePages {
            pagesFetched += 1
            var request = URLRequest(url: url)
            if let authToken {
                request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
            }
            request = request.applyOrOriginal(proxy: proxy)
            let (data, httpResponse) = try await fetchPage(request)
            guard (200..<300).contains(httpResponse.statusCode) else {
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
            viable = filterViableReleases(releases)
            reachedCurrentVersion = hasReached(currentVersion, on: releases)
            nextURL = Self.nextPageURL(
                linkHeader: httpResponse.value(forHTTPHeaderField: "Link"),
                expectedHost: url.host
            )
        }

        return viable
    }

    /// Whether this page ends the search for `currentVersion`.
    ///
    /// `/releases` is ordered by creation, not by version, so a single older
    /// tag on a page does not mean the walk has passed the running build: a
    /// backport published after a newer release, or a tag that fails tolerant
    /// parsing (which decodes to `Version.null`, i.e. `0.0.0`), would otherwise
    /// stop page one and hide the installable release sitting further back.
    ///
    /// So stop only when either the running build's own release is on this page
    /// or every parsed release on it is older — one page past a stray backport
    /// at worst. Unparsed tags are ignored rather than treated as ancient, and
    /// a page with nothing parsable never stops the walk.
    func hasReached(_ currentVersion: Version, on releases: [Release]) -> Bool {
        let parsed = releases.map(\.tagName).filter { $0 != Version(0, 0, 0) }
        guard !parsed.isEmpty else { return false }
        if parsed.contains(currentVersion) { return true }
        return parsed.allSatisfy { $0 < currentVersion }
    }

    /// Adds the largest page size GitHub allows so a single round-trip covers
    /// as much release history as possible. An existing `per_page` (e.g. from
    /// a test host) is preserved.
    static func firstPageURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        let existing = components.queryItems ?? []
        guard !existing.contains(where: { $0.name == "per_page" }) else { return url }
        components.queryItems = existing + [URLQueryItem(name: "per_page", value: String(releasesPerPage))]
        return components.url ?? url
    }

    /// Extracts the `rel="next"` target from an RFC 8288 `Link` header, which
    /// is how GitHub advertises further release pages. Targets that are not
    /// HTTP(S) — or that leave `expectedHost`, when given — are ignored, so a
    /// hostile header cannot walk the authenticated request off the update host.
    static func nextPageURL(linkHeader: String?, expectedHost: String? = nil) -> URL? {
        guard let linkHeader else { return nil }
        for link in linkHeader.split(separator: ",") {
            let segments = link.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
            guard let target = segments.first,
                target.hasPrefix("<"), target.hasSuffix(">"),
                segments.dropFirst().contains(where: { Self.isNextRelation($0) })
            else { continue }
            let raw = String(target.dropFirst().dropLast())
            guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
                scheme == "https" || scheme == "http"
            else { continue }
            if let expectedHost, url.host?.lowercased() != expectedHost.lowercased() { continue }
            return url
        }
        return nil
    }

    private static func isNextRelation(_ parameter: String) -> Bool {
        let normalized = parameter.replacingOccurrences(of: " ", with: "").lowercased()
        return normalized == "rel=next" || normalized == "rel=\"next\"" || normalized == "rel='next'"
    }

    private static let urlSessionFetchPage: PageFetcher = { request in
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, httpResponse)
    }

    /// Keeps only releases that ship an installable macOS asset. Exposed at
    /// internal visibility so tests can exercise the predicate against decoded
    /// JSON fixtures without a network round-trip.
    func filterViableReleases(_ releases: [Release]) -> [Release] {
        releases.filter { hasViableMacOSAsset($0) }
    }

    /// Replicates `AppUpdater.Release.viableAsset(forRelease:)` (internal to
    /// the AppUpdater module, hence not callable): a release is kept when any
    /// asset is either the `<prefix>-<tagName>.zip` (content type zip) or the
    /// `<prefix>-<tagName>.tar` (content type tar) variant, using the parsed
    /// `tagName` exactly as AppUpdater does. `name` is the asset name with its
    /// extension stripped, so it equals `prefix` for both variants; the two
    /// cases are differentiated by content type + file extension.
    private func hasViableMacOSAsset(_ release: Release) -> Bool {
        let prefix = "\(releasePrefix.lowercased())-\(release.tagName)"
        return release.assets.contains { asset in
            let name = (asset.name as NSString).deletingPathExtension.lowercased()
            let fileExtension = (asset.name as NSString).pathExtension
            switch (name, asset.contentTyle, fileExtension) {
            case (prefix, .tar, "tar"):
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
