import SwiftUI
import XCTest

@testable import SliccFollower

@MainActor
final class ThemePaletteTests: XCTestCase {

    private func theme(
        base: SliccTheme.Base = .dark, tokens: [String: String] = [:]
    ) -> SliccTheme {
        SliccTheme(id: "t", name: "Test", base: base, tokens: tokens)
    }

    func testHexTokenParsesSixAndThreeDigitForms() {
        XCTAssertNotNil(Color(hexToken: "#0a0a0a"))
        XCTAssertNotNil(Color(hexToken: " #ABC "))
        XCTAssertEqual(Color(hexToken: "#abc"), Color(hexToken: "#aabbcc"))
    }

    func testHexTokenRejectsNonHexValues() {
        XCTAssertNil(Color(hexToken: "red"))
        XCTAssertNil(Color(hexToken: "var(--ink)"))
        XCTAssertNil(Color(hexToken: "color-mix(in srgb, #fff 50%, #000)"))
        XCTAssertNil(Color(hexToken: "#12345"))
        XCTAssertNil(Color(hexToken: "#zzzzzz"))
    }

    func testUnthemedFollowsTheSystemScheme() {
        XCTAssertEqual(
            ThemePalette.resolve(theme: nil, systemScheme: .dark), ThemePalette.dark)
        XCTAssertEqual(
            ThemePalette.resolve(theme: nil, systemScheme: .light), ThemePalette.light)
    }

    func testThemedIgnoresTheSystemScheme() {
        let light = theme(base: .light)
        XCTAssertEqual(
            ThemePalette.resolve(theme: light, systemScheme: .dark),
            ThemePalette.fromTheme(light),
            "a leader theme pins the palette regardless of the OS setting")
    }

    func testTokensOverrideAndSparseMapsFallBackPerSlot() {
        let themed = ThemePalette.fromTheme(
            theme(base: .dark, tokens: ["--canvas": "#123456"]))
        XCTAssertEqual(themed.canvas, Color(hexToken: "#123456"))

        XCTAssertEqual(themed.surface, ThemePalette.dark.surface)
        XCTAssertEqual(themed.ink, ThemePalette.dark.ink)
        XCTAssertTrue(themed.isLeaderTheme)
    }

    func testUnparseableTokenValueKeepsTheFallback() {
        let themed = ThemePalette.fromTheme(
            theme(base: .light, tokens: ["--ink": "var(--nope)"]))
        XCTAssertEqual(themed.ink, ThemePalette.light.ink)
    }

    func testSprinkleCSSCarriesTokensAndMappings() {
        let css = theme(
            base: .dark,
            tokens: ["--canvas": "#0c1510", "--ink": "#e8f2ec", "--ctx": "#34d399"]
        ).sprinkleCSSOverrides
        XCTAssertTrue(css.contains("--canvas: #0c1510;"))
        XCTAssertTrue(css.contains("--s-text-primary: #e8f2ec;"))
        XCTAssertTrue(css.contains("--s-accent: #34d399;"))
        XCTAssertTrue(css.contains("color-scheme: dark"))
    }

    func testSprinkleCSSDropsUnsafeNamesAndValues() {
        let css = theme(
            base: .dark,
            tokens: [
                "--evil": "#fff}</style><script>alert(1)</script>",
                "not-a-var": "#ffffff",
                "--ok": "#ffffff",
            ]
        ).sprinkleCSSOverrides
        XCTAssertFalse(css.contains("script"), "injection attempts never reach the style block")
        XCTAssertFalse(css.contains("--evil"))
        XCTAssertFalse(css.contains("not-a-var"))
        XCTAssertTrue(css.contains("--ok: #ffffff;"))
    }

    func testBareBaseThemeStillDeclaresColorScheme() {
        let css = theme(base: .light).sprinkleCSSOverrides
        XCTAssertEqual(css, "html { color-scheme: light; }")
    }

    func testThemedBubbleFollowsTheDeepContract() {

        let dark = ThemePalette.fromTheme(theme(base: .dark))
        XCTAssertEqual(dark.bubble, Color(hexToken: "#f5f5f2"))
        XCTAssertEqual(dark.bubbleText, Color(hexToken: "#0a0a0a"))

        let light = ThemePalette.fromTheme(theme(base: .light))
        XCTAssertEqual(light.bubble, Color(hexToken: "#000000") ?? .black)
        XCTAssertEqual(light.bubbleText, .white)

        let custom = ThemePalette.fromTheme(
            theme(base: .dark, tokens: ["--deep": "#123456"]))
        XCTAssertEqual(custom.bubble, Color(hexToken: "#123456"))
        XCTAssertEqual(custom.bubbleText, Color(hexToken: "#0a0a0a"))
    }

    func testUnthemedDarkKeepsTheShippedBubble() {
        XCTAssertEqual(ThemePalette.dark.bubble, ThemePalette.dark.accent)
        XCTAssertEqual(ThemePalette.dark.bubbleText, .white)
    }

    func testApplyLeaderThemeDecodesAndPublishes() {
        let state = AppState()
        state.applyLeaderTheme(
            ##"{"id":"x","name":"X","base":"light","tokens":{"--canvas":"#ffffff"}}"##)
        XCTAssertEqual(state.leaderTheme?.base, .light)
        XCTAssertEqual(state.leaderTheme?.tokens["--canvas"], "#ffffff")
    }

    func testApplyLeaderThemeNilResetsToSystem() {
        let state = AppState()
        state.applyLeaderTheme(#"{"id":"x","name":"X","base":"dark","tokens":{}}"#)
        XCTAssertNotNil(state.leaderTheme)
        state.applyLeaderTheme(nil)
        XCTAssertNil(state.leaderTheme, "themeJson: null resets to the system scheme")
    }

    func testApplyLeaderThemeUndecodableResets() {
        let state = AppState()
        state.applyLeaderTheme(#"{"id":"x","name":"X","base":"dark","tokens":{}}"#)
        state.applyLeaderTheme("{not json")
        XCTAssertNil(state.leaderTheme, "garbage must not strand a stale theme")
    }
}
