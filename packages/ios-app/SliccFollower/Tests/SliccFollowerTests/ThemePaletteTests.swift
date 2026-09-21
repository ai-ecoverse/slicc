import SwiftUI
import XCTest

@testable import SliccFollower

/// Palette resolution + sprinkle CSS derivation for leader themes (#1801
/// phase 2). The HSL token math itself is pinned by `ThemeVectorTests`;
/// these cover what the views and webviews consume.
@MainActor
final class ThemePaletteTests: XCTestCase {

    private func theme(
        base: SliccTheme.Base = .dark, tokens: [String: String] = [:]
    ) -> SliccTheme {
        SliccTheme(id: "t", name: "Test", base: base, tokens: tokens)
    }

    // MARK: Hex parsing

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

    // MARK: Resolution

    func testUnthemedFollowsTheSystemScheme() {
        XCTAssertEqual(
            ThemePalette.resolve(theme: nil, systemScheme: .dark), ThemePalette.dark)
        XCTAssertEqual(
            ThemePalette.resolve(theme: nil, systemScheme: .light), ThemePalette.light)
    }

    func testMatchingSchemeAppliesTheFullTheme() {
        let light = theme(base: .light, tokens: ["--canvas": "#fff8f0"])
        XCTAssertEqual(
            ThemePalette.resolve(theme: light, systemScheme: .light),
            ThemePalette.fromTheme(light),
            "a theme authored for the device appearance paints its tokens")
    }

    func testMismatchedSchemeKeepsTheAccentAndTheDeviceSurfaces() {
        let darkTheme = theme(
            base: .dark,
            tokens: [
                "--canvas": "#112233",
                "--ink": "#eeeeee",
                "--ctx": "#34d399",
            ])
        let resolved = ThemePalette.resolve(theme: darkTheme, systemScheme: .light)
        XCTAssertEqual(resolved.canvas, ThemePalette.light.canvas)
        XCTAssertEqual(resolved.ink, ThemePalette.light.ink)
        XCTAssertEqual(resolved.bubble, ThemePalette.light.bubble)
        XCTAssertEqual(resolved.bubbleText, ThemePalette.light.bubbleText)
        XCTAssertEqual(resolved.accent, Color(hexToken: "#34d399"))
        XCTAssertTrue(resolved.isLeaderTheme)

        let lightTheme = theme(base: .light, tokens: ["--canvas": "#fff8f0"])
        let darkDevice = ThemePalette.resolve(theme: lightTheme, systemScheme: .dark)
        XCTAssertEqual(darkDevice.canvas, ThemePalette.dark.canvas)
        XCTAssertEqual(darkDevice.accent, ThemePalette.dark.accent)
        XCTAssertTrue(darkDevice.isLeaderTheme)
    }

    func testTokensOverrideAndSparseMapsFallBackPerSlot() {
        let themed = ThemePalette.fromTheme(
            theme(base: .dark, tokens: ["--canvas": "#123456"]))
        XCTAssertEqual(themed.canvas, Color(hexToken: "#123456"))
        // Every unspecified slot keeps the base default.
        XCTAssertEqual(themed.surface, ThemePalette.dark.surface)
        XCTAssertEqual(themed.ink, ThemePalette.dark.ink)
        XCTAssertTrue(themed.isLeaderTheme)
    }

    func testUnparseableTokenValueKeepsTheFallback() {
        let themed = ThemePalette.fromTheme(
            theme(base: .light, tokens: ["--ink": "var(--nope)"]))
        XCTAssertEqual(themed.ink, ThemePalette.light.ink)
    }

    // MARK: Sprinkle CSS

    func testSprinkleCSSCarriesTokensAndMappings() {
        let css = theme(
            base: .dark,
            tokens: ["--canvas": "#0c1510", "--ink": "#e8f2ec", "--ctx": "#34d399"]
        ).sprinkleCSSOverrides(for: .dark)
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
        ).sprinkleCSSOverrides(for: .dark)
        XCTAssertFalse(css.contains("script"), "injection attempts never reach the style block")
        XCTAssertFalse(css.contains("--evil"))
        XCTAssertFalse(css.contains("not-a-var"))
        XCTAssertTrue(css.contains("--ok: #ffffff;"))
    }

    func testBareBaseThemeStillDeclaresColorScheme() {
        let css = theme(base: .light).sprinkleCSSOverrides(for: .light)
        XCTAssertEqual(css, "html { color-scheme: light; }")
    }

    func testSprinkleCSSFollowsTheDeviceWhenTheThemeBaseDiffers() {
        let css = theme(
            base: .dark,
            tokens: ["--canvas": "#0c1510", "--ink": "#e8f2ec", "--ctx": "#34d399"]
        ).sprinkleCSSOverrides(for: .light)
        XCTAssertFalse(css.contains("--canvas"))
        XCTAssertFalse(css.contains("--ink"))
        XCTAssertFalse(css.contains("--s-text-primary"))
        XCTAssertTrue(css.contains("--ctx: #34d399;"))
        XCTAssertTrue(css.contains("--s-accent: #34d399;"))
        XCTAssertTrue(css.contains("color-scheme: light"))
        XCTAssertFalse(css.contains("color-scheme: dark"))
    }

    func testBareThemeOnTheOtherAppearanceDeclaresTheDeviceScheme() {
        let css = theme(base: .light).sprinkleCSSOverrides(for: .dark)
        XCTAssertEqual(css, "html { color-scheme: dark; }")
    }

    // MARK: Bubble contrast

    func testThemedBubbleFollowsTheDeepContract() {
        // Dark base: near-white --deep default, near-black text.
        let dark = ThemePalette.fromTheme(theme(base: .dark))
        XCTAssertEqual(dark.bubble, Color(hexToken: "#f5f5f2"))
        XCTAssertEqual(dark.bubbleText, Color(hexToken: "#0a0a0a"))
        // Light base: black --deep default, white text.
        let light = ThemePalette.fromTheme(theme(base: .light))
        XCTAssertEqual(light.bubble, Color(hexToken: "#000000") ?? .black)
        XCTAssertEqual(light.bubbleText, .white)
        // A --deep token overrides the ground; the text still flips by base,
        // so a light accent can never sit under white text.
        let custom = ThemePalette.fromTheme(
            theme(base: .dark, tokens: ["--deep": "#123456"]))
        XCTAssertEqual(custom.bubble, Color(hexToken: "#123456"))
        XCTAssertEqual(custom.bubbleText, Color(hexToken: "#0a0a0a"))
    }

    func testUnthemedDarkKeepsTheShippedBubble() {
        XCTAssertEqual(ThemePalette.dark.bubble, ThemePalette.dark.accent)
        XCTAssertEqual(ThemePalette.dark.bubbleText, .white)
    }

    // MARK: AppState wiring

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
