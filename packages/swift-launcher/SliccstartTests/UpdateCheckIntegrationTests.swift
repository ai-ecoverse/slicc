import AppUpdater
import Version
import XCTest

@testable import Sliccstart

/// Integration tests that hit the real GitHub API to verify release fetching
/// against the actual ai-ecoverse/slicc release history. The live network
/// call gives us release-naming-drift detection that a frozen JSON fixture
/// could not.
///
/// Both tests share a single authenticated HTTP call so the suite stays
/// inside GitHub's rate budget even on shared CI runner IPs. The token is
/// read from `GH_TOKEN` (set by ci.yml from `${{ github.token }}`); if it
/// is absent — e.g. when running locally without auth — the tests fall
/// back to the unauthenticated path and may flake under contention.
final class UpdateCheckIntegrationTests: XCTestCase {

    // MARK: - TolerantGithubReleaseProvider (the fix)

    func testTolerantProviderFetchesReleasesWithCorrectVersions() async throws {
        // The provider reads GH_TOKEN from the environment in its default
        // initializer, so this single call is authenticated whenever the
        // workflow exposes ${{ github.token }}.
        let provider = TolerantGithubReleaseProvider()
        let releases = try await provider.fetchReleases(
            owner: "ai-ecoverse", repo: "slicc", proxy: nil
        )

        // We have many releases — at least 5. `fetchReleases` only returns
        // releases carrying an installable macOS asset (Sliccstart-*.zip), and
        // native artifacts are now built conditionally, so the filtered list can
        // be small. Assert the "many releases" intent against the UNFILTERED
        // release list instead.
        let rawData = try await fetchReleasesJSON(owner: "ai-ecoverse", repo: "slicc")
        let rawReleases = try JSONDecoder().decode([Release].self, from: rawData)
        XCTAssertGreaterThanOrEqual(
            rawReleases.count, 5,
            "Expected at least 5 releases from ai-ecoverse/slicc, got \(rawReleases.count)"
        )

        // At least one release should have a real version (not 0.0.0),
        // proving that the v-prefix parsing works.
        let nonNullVersions = releases.filter { $0.tagName != Version(0, 0, 0) }
        XCTAssertFalse(
            nonNullVersions.isEmpty,
            "Expected at least one release with a parsed version (not 0.0.0). "
                + "All \(releases.count) releases decoded as Version.null — tolerant decoding may be broken."
        )

        // At least one release should have a Sliccstart asset (zip),
        // proving the naming convention matches what viableAsset expects.
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

    /// Proves the pagination walk works against GitHub's real `Link` headers:
    /// forcing `per_page=1` keeps each page to a single release, so unless that
    /// one release is itself installable the provider must parse `rel="next"`
    /// out of a live header to get anywhere. A frozen fixture could not catch
    /// header-format drift. `ReleaseFetchPaginationTests` covers the walk's
    /// mechanics deterministically; this test exists only to notice when the
    /// real header stops looking like what we parse.
    ///
    /// This asserts on the *walk*, deliberately not on reaching an installable
    /// release. Native artifacts are built conditionally, so the newest
    /// asset-bearing release drifts arbitrarily far down the list as ordinary
    /// releases accumulate — at one release per page it slid past the
    /// `maxReleasePages` loop guard, which failed this test for reasons that
    /// had nothing to do with pagination. That the walk does reach an
    /// installable release stays covered by
    /// `testTolerantProviderFetchesReleasesWithCorrectVersions`, which runs at
    /// the production page size.
    func testPaginationWalkFollowsRealLinkHeaders() async throws {
        // `currentVersion` is pinned: the walk stops at the running build's own
        // release, and the XCTest host bundle's version is unrelated to the
        // repo's release history.
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

        // The walk stops as soon as a page yields a viable release, so page 1
        // is enough exactly when the newest release ships an asset — which is
        // the state right after a `packages/swift-launcher/**` change cuts a
        // release. Demanding pagination unconditionally would just invert the
        // churn flake this test was rewritten to remove.
        //
        // What must always hold: the walk either found something, or it proved
        // it could keep going. Coming back with nothing after a single page is
        // the signature of a `rel="next"` we failed to parse — a page-1 miss
        // has more releases behind it, so the walk had somewhere to go.
        let pages = await pagesFetched.value
        XCTAssertTrue(
            pages > 1 || !releases.isEmpty,
            "The walk stopped after \(pages) page(s) with no viable release. GitHub's Link "
                + "header format may have drifted, leaving `rel=\"next\"` unparsed."
        )

        // Whatever the walk did surface must be installable — filtering to an
        // installable asset is the point of `fetchReleases`, and it still holds
        // when release churn means the walk surfaces nothing.
        for release in releases {
            XCTAssertTrue(
                release.assets.contains { $0.name.hasPrefix("Sliccstart-") && $0.name.hasSuffix(".zip") },
                "fetchReleases returned \(release.tagName) without an installable Sliccstart-*.zip asset"
            )
        }
    }

    /// Serialises the page tally across the provider's `@Sendable` fetch seam.
    private actor PageCounter {
        private(set) var value = 0
        func increment() { value += 1 }
    }

    // MARK: - Strict decoder (the bug — contrast test)

    /// Confirms that the *strict* decoder path silently drops every v-prefixed
    /// tag to `Version(0,0,0)` when applied to real release JSON. This is the
    /// regression contract the `TolerantGithubReleaseProvider` wrapper exists
    /// to defeat: if AppUpdater (or the upstream `Version` decoder) ever
    /// changes its default to accept v-prefix, this test fails and the wrapper
    /// can be removed.
    ///
    /// Replicates what `AppUpdater.GithubReleaseProvider.fetchReleases` does
    /// internally — `URLSession` + `JSONDecoder().decode([Release].self,...)`
    /// — but with auth so the call survives shared-runner rate limits.
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

    // MARK: - Helpers

    /// Direct authenticated fetch of the releases JSON, mirroring what
    /// `TolerantGithubReleaseProvider` does so the strict-decoder test can
    /// share rate budget without depending on the wrapper class.
    private func fetchReleasesJSON(owner: String, repo: String) async throws -> Data {
        let url = URL(string: "https://api.github.com/repos/\(owner)/\(repo)/releases")!
        var request = URLRequest(url: url)
        // An empty GH_TOKEN must be treated as no token — `Bearer ` makes
        // GitHub answer 401 and the whole suite fails with a misleading
        // `URLError(.badServerResponse)`, same trap the provider guards.
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
