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
struct TolerantGithubReleaseProvider: ReleaseProvider {
    private let github = GithubReleaseProvider()

    func fetchReleases(owner: String, repo: String, proxy: URLRequestProxy?) async throws -> [Release] {
        let url = URL(string: "https://api.github.com/repos/\(owner)/\(repo)/releases")!
        var request = URLRequest(url: url)
        request = request.applyOrOriginal(proxy: proxy)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let decoder = JSONDecoder()
        decoder.userInfo[.decodingMethod] = DecodingMethod.tolerant
        return try decoder.decode([Release].self, from: data)
    }

    func download(asset: Release.Asset, to saveLocation: URL, proxy: URLRequestProxy?) async throws -> AsyncThrowingStream<DownloadingState, Error> {
        try await github.download(asset: asset, to: saveLocation, proxy: proxy)
    }

    func fetchAssetData(asset: Release.Asset, proxy: URLRequestProxy?) async throws -> Data {
        try await github.fetchAssetData(asset: asset, proxy: proxy)
    }
}

