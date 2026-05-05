import XCTest
import AppUpdater
import Version
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

        // We have many releases — at least 5
        XCTAssertGreaterThanOrEqual(
            releases.count, 5,
            "Expected at least 5 releases from ai-ecoverse/slicc, got \(releases.count)"
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
        if let token = ProcessInfo.processInfo.environment["GH_TOKEN"] {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return data
    }
}
