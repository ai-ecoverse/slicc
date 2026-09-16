import AppUpdater
import Version
import XCTest

@testable import Sliccstart

final class UpdateCheckIntegrationTests: XCTestCase {

    func testTolerantProviderFetchesReleasesWithCorrectVersions() async throws {

        let provider = TolerantGithubReleaseProvider()
        let releases = try await provider.fetchReleases(
            owner: "ai-ecoverse", repo: "slicc", proxy: nil
        )

        let rawData = try await fetchReleasesJSON(owner: "ai-ecoverse", repo: "slicc")
        let rawReleases = try JSONDecoder().decode([Release].self, from: rawData)
        XCTAssertGreaterThanOrEqual(
            rawReleases.count, 5,
            "Expected at least 5 releases from ai-ecoverse/slicc, got \(rawReleases.count)"
        )

        let nonNullVersions = releases.filter { $0.tagName != Version(0, 0, 0) }
        XCTAssertFalse(
            nonNullVersions.isEmpty,
            "Expected at least one release with a parsed version (not 0.0.0). "
                + "All \(releases.count) releases decoded as Version.null — tolerant decoding may be broken."
        )

        let hasSliccstartAsset = releases.contains { release in
            release.assets.contains { asset in
                asset.name.hasPrefix("Sliccstart-") && asset.name.hasSuffix(".zip")
            }
        }
        XCTAssertTrue(
            hasSliccstartAsset,
            "Expected at least one release with a Sliccstart-*.zip asset"
        )
    }

    func testPaginationWalkFollowsRealLinkHeaders() async throws {

        let pagesFetched = PageCounter()
        let provider = TolerantGithubReleaseProvider(
            currentVersion: Version(0, 0, 0),
            fetchPage: { request in
                var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                var items = (components.queryItems ?? []).filter { $0.name != "per_page" }
                items.append(URLQueryItem(name: "per_page", value: "1"))
                components.queryItems = items
                var paged = request
                paged.url = components.url
                await pagesFetched.increment()
                let (data, response) = try await URLSession.shared.data(for: paged)
                guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                return (data, http)
            })

        let releases = try await provider.fetchReleases(owner: "ai-ecoverse", repo: "slicc", proxy: nil)

        let pages = await pagesFetched.value
        XCTAssertTrue(
            pages > 1 || !releases.isEmpty,
            "The walk stopped after \(pages) page(s) with no viable release. GitHub's Link "
                + "header format may have drifted, leaving `rel=\"next\"` unparsed."
        )

        for release in releases {
            XCTAssertTrue(
                release.assets.contains { $0.name.hasPrefix("Sliccstart-") && $0.name.hasSuffix(".zip") },
                "fetchReleases returned \(release.tagName) without an installable Sliccstart-*.zip asset"
            )
        }
    }

    private actor PageCounter {
        private(set) var value = 0
        func increment() { value += 1 }
    }

    func testStrictDecoderOnRealReleasesProducesNullVersions() async throws {
        let data = try await fetchReleasesJSON(owner: "ai-ecoverse", repo: "slicc")
        let releases = try JSONDecoder().decode([Release].self, from: data)

        XCTAssertFalse(releases.isEmpty, "Expected at least some releases from strict decode")

        let nullVersions = releases.filter { $0.tagName == Version(0, 0, 0) }
        XCTAssertFalse(
            nullVersions.isEmpty,
            "Expected at least one release decoded with the strict default to have tagName == "
                + "Version(0,0,0) (proving the v-prefix bug), but none did. If this is the new "
                + "normal, TolerantGithubReleaseProvider can be removed."
        )
    }

    private func fetchReleasesJSON(owner: String, repo: String) async throws -> Data {
        let url = URL(string: "https://api.github.com/repos/\(owner)/\(repo)/releases")!
        var request = URLRequest(url: url)

        if let token = ProcessInfo.processInfo.environment["GH_TOKEN"], !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        try await skipIfLatestReleaseContradictsEmptyList(data, owner: owner, repo: repo)
        return data
    }

    private func skipIfLatestReleaseContradictsEmptyList(
        _ releasesData: Data,
        owner: String,
        repo: String
    ) async throws {
        guard
            let releases = try? JSONDecoder().decode([Release].self, from: releasesData),
            releases.isEmpty
        else { return }

        let url = URL(string: "https://api.github.com/repos/\(owner)/\(repo)/releases/latest")!
        var request = URLRequest(url: url)
        if let token = ProcessInfo.processInfo.environment["GH_TOKEN"], !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard
            let http = response as? HTTPURLResponse,
            (200..<300).contains(http.statusCode),
            (try? JSONDecoder().decode(Release.self, from: data)) != nil
        else { return }

        throw XCTSkip(
            "GitHub's releases list is empty while its latest-release endpoint reports an existing release"
        )
    }
}
