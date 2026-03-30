import XCTest
import AppUpdater
import Version
@testable import Sliccstart

/// Integration tests that hit the real GitHub API to verify release fetching
/// against the actual ai-ecoverse/slicc release history.
///
/// These tests require network access and will fail in offline environments.
final class UpdateCheckIntegrationTests: XCTestCase {

    // MARK: - TolerantGithubReleaseProvider (the fix)

    func testTolerantProviderFetchesReleasesWithCorrectVersions() async throws {
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

    // MARK: - GithubReleaseProvider (the bug — contrast test)

    func testStrictProviderDecodesAllVersionsAsNull() async throws {
        let provider = GithubReleaseProvider()
        let releases = try await provider.fetchReleases(
            owner: "ai-ecoverse", repo: "slicc", proxy: nil
        )

        // The strict provider should still decode releases (the JSON is valid),
        // but every tag_name with a "v" prefix decodes as Version(0,0,0).
        XCTAssertFalse(releases.isEmpty, "Expected at least some releases from strict provider")

        let allNull = releases.allSatisfy { $0.tagName == Version(0, 0, 0) }
        XCTAssertTrue(
            allNull,
            "Expected ALL releases from strict GithubReleaseProvider to have tagName == Version(0,0,0) "
            + "(proving the v-prefix bug), but some had real versions."
        )
    }
}

