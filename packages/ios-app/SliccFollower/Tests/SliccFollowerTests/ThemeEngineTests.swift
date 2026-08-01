import XCTest

@testable import SliccFollower

/// Cross-implementation parity for the theme derivation: every vector in
/// Fixtures/theme-vectors.json (generated from the canonical TS
/// implementation by gen-theme-vectors.mjs) must reproduce byte-identically
/// through the Swift port. The TS suite asserts the same file, so neither
/// side can drift silently.
final class ThemeEngineTests: XCTestCase {
    private struct Vector: Decodable {
        let name: String
        let base: SliccTheme.Base
        let slots: ThemeSlots
        let expected: [String: String]
    }

    private func loadVectors() throws -> [Vector] {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "theme-vectors", withExtension: "json"),
            "theme-vectors.json missing from the test bundle")
        return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
    }

    func testEveryVectorReproduces() throws {
        let vectors = try loadVectors()
        XCTAssertGreaterThanOrEqual(vectors.count, 5)
        for vector in vectors {
            let derived = ThemeEngine.deriveTokens(slots: vector.slots, base: vector.base)
            XCTAssertEqual(
                derived, vector.expected,
                "vector \"\(vector.name)\" diverged — regenerate with gen-theme-vectors.mjs and fix whichever side changed"
            )
        }
    }

    func testThemeApplyPayloadDecodes() throws {
        let json = """
            {"id":"t1","name":"Night","base":"dark",
            "tokens":{"--canvas":"#101020"},"disableShader":true,
            "css":".x{}","components":{"nav":{"background":"#000"}}}
            """.replacingOccurrences(of: "\n", with: "")
        let theme = try JSONDecoder().decode(SliccTheme.self, from: Data(json.utf8))
        XCTAssertEqual(theme.base, .dark)
        XCTAssertEqual(theme.tokens["--canvas"], "#101020")
        XCTAssertEqual(theme.disableShader, true)
    }

    func testHslRoundTripsThePalette() {
        for hex in ["#0f0f1a", "#7155fa", "#ffffff", "#000000", "#808080", "#ff0000"] {
            let (h, s, l) = ThemeEngine.hexToHsl(hex)
            XCTAssertEqual(ThemeEngine.hslToHex(h, s, l), hex, "round trip broke for \(hex)")
        }
    }
}
