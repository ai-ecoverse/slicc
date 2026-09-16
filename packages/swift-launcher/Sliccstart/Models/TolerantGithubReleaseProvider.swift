import AppUpdater
import Foundation
import Version

struct TolerantGithubReleaseProvider: ReleaseProvider {

    typealias PageFetcher = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

    static let releasesPerPage = 100

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

        let resolved = authToken ?? ProcessInfo.processInfo.environment["GH_TOKEN"]
        self.authToken = resolved.flatMap { $0.isEmpty ? nil : $0 }
        self.host = host
        self.releasePrefix = releasePrefix
        self.currentVersion = currentVersion
        self.fetchPage = fetchPage ?? Self.urlSessionFetchPage
    }

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

            viable = filterViableReleases(releases)
            reachedCurrentVersion = hasReached(currentVersion, on: releases)
            nextURL = Self.nextPageURL(
                linkHeader: httpResponse.value(forHTTPHeaderField: "Link"),
                expectedHost: url.host
            )
        }

        return viable
    }

    func hasReached(_ currentVersion: Version, on releases: [Release]) -> Bool {
        let parsed = releases.map(\.tagName).filter { $0 != Version(0, 0, 0) }
        guard !parsed.isEmpty else { return false }
        if parsed.contains(currentVersion) { return true }
        return parsed.allSatisfy { $0 < currentVersion }
    }

    static func firstPageURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        let existing = components.queryItems ?? []
        guard !existing.contains(where: { $0.name == "per_page" }) else { return url }
        components.queryItems = existing + [URLQueryItem(name: "per_page", value: String(releasesPerPage))]
        return components.url ?? url
    }

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

    func filterViableReleases(_ releases: [Release]) -> [Release] {
        releases.filter { hasViableMacOSAsset($0) }
    }

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
