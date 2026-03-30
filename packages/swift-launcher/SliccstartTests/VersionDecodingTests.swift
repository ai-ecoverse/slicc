import XCTest
import AppUpdater
import Version
@testable import Sliccstart

final class VersionDecodingTests: XCTestCase {
    private let json = """
    [{
      "tag_name": "v1.36.0",
      "prerelease": false,
      "name": "v1.36.0",
      "html_url": "https://github.com/ai-ecoverse/slicc/releases/tag/v1.36.0",
      "body": "test release",
      "assets": [{
        "name": "Sliccstart-1.36.0.zip",
        "browser_download_url": "https://example.com/Sliccstart-1.36.0.zip",
        "content_type": "application/zip"
      }]
    }]
    """.data(using: .utf8)!

    func testStrictDecoderRejectsVPrefixedTags() throws {
        let decoder = JSONDecoder()
        let releases = try decoder.decode([Release].self, from: json)
        XCTAssertEqual(releases.count, 1)
        // Strict decoding fails to parse "v1.36.0" and falls back to Version(0,0,0)
        XCTAssertEqual(releases[0].tagName, Version(0, 0, 0))
    }

    func testTolerantDecoderAcceptsVPrefixedTags() throws {
        let decoder = JSONDecoder()
        decoder.userInfo[.decodingMethod] = DecodingMethod.tolerant
        let releases = try decoder.decode([Release].self, from: json)
        XCTAssertEqual(releases.count, 1)
        XCTAssertEqual(releases[0].tagName, Version(1, 36, 0))
    }
}

