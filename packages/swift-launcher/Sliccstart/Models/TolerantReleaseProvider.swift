import Foundation
import AppUpdater
import Version

/// A ReleaseProvider wrapper that uses tolerant Version decoding.
///
/// The default `GithubReleaseProvider` uses a strict `JSONDecoder` that
/// rejects version tags with a `v` prefix (e.g. `v1.11.1`). This wrapper
/// fetches the same GitHub API but configures the decoder with
/// `DecodingMethod.tolerant` so `v`-prefixed semver tags parse correctly.
struct TolerantReleaseProvider: ReleaseProvider {
    private let inner = GithubReleaseProvider()

    func fetchReleases(owner: String, repo: String, proxy: URLRequestProxy?) async throws -> [Release] {
        let slug = "\(owner)/\(repo)"
        let url = URL(string: "https://api.github.com/repos/\(slug)/releases")!

        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }

        let decoder = JSONDecoder()
        decoder.userInfo[.decodingMethod] = DecodingMethod.tolerant
        return try decoder.decode([Release].self, from: data)
    }

    func download(asset: Release.Asset, to saveLocation: URL, proxy: URLRequestProxy?) async throws -> AsyncThrowingStream<DownloadingState, Error> {
        return try await inner.download(asset: asset, to: saveLocation, proxy: proxy)
    }

    func fetchAssetData(asset: Release.Asset, proxy: URLRequestProxy?) async throws -> Data {
        return try await inner.fetchAssetData(asset: asset, proxy: proxy)
    }
}

