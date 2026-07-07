import XCTest
import AppUpdater
import Version
@testable import Sliccstart

/// Unit coverage for `TolerantGithubReleaseProvider.filterViableReleases`,
/// which replicates AppUpdater's internal `Release.viableAsset` predicate so
/// releases lacking an installable `Sliccstart-<version>.zip` (or `.tar`)
/// macOS asset are dropped before `findViableUpdate` picks a target. Fixtures
/// are decoded from JSON with the same tolerant decoder the provider uses.
final class ReleaseAssetFilterTests: XCTestCase {

    private func decode(_ json: String) throws -> [Release] {
        let decoder = JSONDecoder()
        decoder.userInfo[.decodingMethod] = DecodingMethod.tolerant
        return try decoder.decode([Release].self, from: Data(json.utf8))
    }

    private func release(
        tag: String,
        assetName: String?,
        contentType: String = "application/zip"
    ) -> String {
        let assets: String
        if let assetName {
            assets = """
            [{
              "name": "\(assetName)",
              "browser_download_url": "https://example.com/\(assetName)",
              "content_type": "\(contentType)"
            }]
            """
        } else {
            assets = "[]"
        }
        return """
        {
          "tag_name": "\(tag)",
          "prerelease": false,
          "name": "\(tag)",
          "html_url": "https://github.com/ai-ecoverse/slicc/releases/tag/\(tag)",
          "body": "test",
          "assets": \(assets)
        }
        """
    }

    private var provider: TolerantGithubReleaseProvider {
        TolerantGithubReleaseProvider(releasePrefix: "Sliccstart")
    }

    func testKeepsReleaseWithMatchingZipAsset() throws {
        let releases = try decode("[\(release(tag: "v1.36.0", assetName: "Sliccstart-1.36.0.zip"))]")
        let kept = provider.filterViableReleases(releases)
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(kept.first?.tagName, Version(1, 36, 0))
    }

    func testKeepsTolerantVPrefixedTag() throws {
        // Tag "v2.0.0" parses to Version 2.0.0, whose description drops the
        // "v", so the asset "Sliccstart-2.0.0.zip" must still match.
        let releases = try decode("[\(release(tag: "v2.0.0", assetName: "Sliccstart-2.0.0.zip"))]")
        XCTAssertEqual(provider.filterViableReleases(releases).count, 1)
    }

    func testMatchIsCaseInsensitiveOnAssetName() throws {
        let releases = try decode("[\(release(tag: "1.0.0", assetName: "SLICCSTART-1.0.0.zip"))]")
        XCTAssertEqual(provider.filterViableReleases(releases).count, 1)
    }

    func testDropsReleaseWithNoAssets() throws {
        let releases = try decode("[\(release(tag: "1.36.0", assetName: nil))]")
        XCTAssertTrue(provider.filterViableReleases(releases).isEmpty)
    }

    func testDropsReleaseWithMismatchedAssetName() throws {
        let releases = try decode("[\(release(tag: "1.36.0", assetName: "Sliccstart-9.9.9.zip"))]")
        XCTAssertTrue(provider.filterViableReleases(releases).isEmpty)
    }

    func testDropsReleaseWithWrongContentType() throws {
        // Correct name and extension but a non-zip content type must not match.
        let releases = try decode("""
        [\(release(
            tag: "1.36.0",
            assetName: "Sliccstart-1.36.0.zip",
            contentType: "application/octet-stream"
        ))]
        """)
        XCTAssertTrue(provider.filterViableReleases(releases).isEmpty)
    }

    func testDropsNewestBinarylessButKeepsOlderViableRelease() throws {
        let json = """
        [
          \(release(tag: "v2.0.0", assetName: nil)),
          \(release(tag: "v1.36.0", assetName: "Sliccstart-1.36.0.zip"))
        ]
        """
        let kept = provider.filterViableReleases(try decode(json))
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(kept.first?.tagName, Version(1, 36, 0))
    }
}
