import SwiftUI

/// The resolved native palette views render from, injected through the
/// SwiftUI environment (`\.palette`) so no view hardcodes hex again.
///
/// Three sources, in precedence order:
/// 1. A leader theme (`theme.apply`) — token map + `base`, mirroring what
///    the browser follower applies. Raw `css` and per-component overrides
///    are deliberately ignored: injecting arbitrary CSS into native views
///    is not meaningful, and the web side sanitizes it precisely because
///    it is dangerous.
/// 2. Unthemed dark — the app's existing hand-tuned dark look, unchanged.
/// 3. Unthemed light — the webapp's canonical light tokens
///    (`packages/webcomponents/src/theme/tokens.css`), so an unthemed
///    phone follows the system scheme like the unthemed webapp shell.
struct ThemePalette: Equatable {
    /// Window/page background (`--canvas`).
    let canvas: Color
    /// Bars, cards, sheets (`--bg`).
    let surface: Color
    /// Input-field fill (`--ghost`).
    let field: Color
    /// Primary text (`--ink`).
    let ink: Color
    /// Secondary text (`--txt-2`).
    let inkSecondary: Color
    /// Tertiary text (`--txt-3`).
    let inkTertiary: Color
    /// Hairlines and separators (`--line`).
    let line: Color
    /// The action accent (scoop accent / `--ctx`).
    let accent: Color
    /// User-bubble ground (`--deep` — the web's inverted iMessage bubble).
    let bubble: Color
    /// User-bubble text. The web contract flips it by base: white on the
    /// light base's near-black `--deep`, near-black on the dark base's
    /// near-white one (`slicc-user-message.ts`).
    let bubbleText: Color
    /// Whether this palette came from a leader theme (drives sprinkle CSS
    /// injection — an unthemed phone lets sprinkle content self-theme).
    let isLeaderTheme: Bool

    /// The existing iOS dark look, byte-for-byte the colors views used to
    /// hardcode — an unthemed dark phone must not change appearance.
    static let dark = ThemePalette(
        canvas: Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255),
        surface: Color(red: 0x1C / 255, green: 0x1C / 255, blue: 0x2E / 255),
        field: Color(white: 1, opacity: 0.07),
        ink: .white,
        inkSecondary: Color.white.opacity(0.7),
        inkTertiary: Color.white.opacity(0.5),
        line: Color(white: 1, opacity: 0.1),
        accent: Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255),
        // Unthemed dark keeps the app's shipped purple bubble + white text
        // (deliberately not the web's --deep inversion — byte-for-byte).
        bubble: Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255),
        bubbleText: .white,
        isLeaderTheme: false
    )

    /// The webapp's canonical light tokens with the app's accent kept.
    static let light = ThemePalette(
        canvas: Color(hexToken: "#ffffff") ?? .white,
        surface: Color(hexToken: "#f4f4f6") ?? .white,
        field: Color(hexToken: "#ececef") ?? .white,
        ink: Color(hexToken: "#0a0a0a") ?? .black,
        inkSecondary: Color(hexToken: "#737373") ?? .gray,
        inkTertiary: Color(hexToken: "#a1a1a1") ?? .gray,
        line: Color(hexToken: "#e5e5e5") ?? .gray,
        accent: Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255),
        // Web light `--deep` is black; the bubble text stays white on it.
        bubble: Color(hexToken: "#000000") ?? .black,
        bubbleText: .white,
        isLeaderTheme: false
    )

    /// Resolve a leader theme into a palette: read the token subset the
    /// native UI consumes, falling back per-slot to the base-appropriate
    /// default so a sparse token map still renders coherently.
    static func fromTheme(_ theme: SliccTheme) -> ThemePalette {
        let base = theme.base == .light ? light : dark
        func token(_ name: String, _ fallback: Color) -> Color {
            guard let raw = theme.tokens[name] else { return fallback }
            return Color(hexToken: raw) ?? fallback
        }
        return ThemePalette(
            canvas: token("--canvas", base.canvas),
            surface: token("--bg", base.surface),
            field: token("--ghost", base.field),
            ink: token("--ink", base.ink),
            inkSecondary: token("--txt-2", base.inkSecondary),
            inkTertiary: token("--txt-3", base.inkTertiary),
            line: token("--line", base.line),
            accent: token("--ctx", base.accent),
            // Themed bubbles follow the WEB contract (not the unthemed-dark
            // purple): `--deep` ground — near-white on a dark base, black on
            // a light one — with text flipped by base, so a light accent can
            // never end up under white text (slicc-user-message.ts parity).
            bubble: token(
                "--deep",
                theme.base == .dark
                    ? (Color(hexToken: "#f5f5f2") ?? .white)
                    : (Color(hexToken: "#000000") ?? .black)),
            bubbleText: theme.base == .dark
                ? (Color(hexToken: "#0a0a0a") ?? .black) : .white,
            isLeaderTheme: true
        )
    }

    /// The palette for the current state: leader theme when active,
    /// otherwise the default matching the effective system scheme.
    static func resolve(theme: SliccTheme?, systemScheme: ColorScheme) -> ThemePalette {
        if let theme { return fromTheme(theme) }
        return systemScheme == .light ? light : dark
    }
}

extension Color {
    /// Parse `#rgb` / `#rrggbb` CSS hex tokens (the only forms the theme
    /// editor emits). Anything else — `color-mix(...)`, `var(...)` — is nil
    /// so callers keep their fallback.
    init?(hexToken: String) {
        let trimmed = hexToken.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("#") else { return nil }
        var hex = String(trimmed.dropFirst())
        if hex.count == 3 {
            hex = hex.map { "\($0)\($0)" }.joined()
        }
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

// MARK: - Environment

private struct ThemePaletteKey: EnvironmentKey {
    static let defaultValue = ThemePalette.dark
}

extension EnvironmentValues {
    /// The resolved palette. Defaults to the dark palette so previews and
    /// isolated views render exactly as before adoption.
    var palette: ThemePalette {
        get { self[ThemePaletteKey.self] }
        set { self[ThemePaletteKey.self] = newValue }
    }
}

// MARK: - Sprinkle theming

private struct SprinkleThemeCSSKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    /// CSS custom-property overrides for sprinkle WKWebViews, derived from
    /// the leader theme ("" when unthemed — sprinkle content then keeps its
    /// own built-in dark tokens).
    var sprinkleThemeCSS: String {
        get { self[SprinkleThemeCSSKey.self] }
        set { self[SprinkleThemeCSSKey.self] = newValue }
    }
}

extension SliccTheme {
    /// CSS injected into sprinkle WKWebViews so web-rendered sprinkle
    /// content follows the leader theme: the raw token map verbatim (full
    /// sprinkle documents read the webapp names like `--canvas`) plus the
    /// `--s-*` mappings iOS's own inline-sprinkle wrapper CSS reads. Values
    /// come off the wire, so both names and values pass a strict character
    /// allowlist — a token can never close the style block or smuggle
    /// markup. Raw theme `css` deliberately never crosses this boundary.
    var sprinkleCSSOverrides: String {
        var lines: [String] = []
        for (name, value) in tokens.sorted(by: { $0.key < $1.key })
        where Self.isSafeCSSName(name) && Self.isSafeCSSValue(value) {
            lines.append("  \(name): \(value);")
        }
        let sMappings: [(String, String)] = [
            ("--s-bg-card", "--bg"),
            ("--s-bg-card-soft", "--ghost"),
            ("--s-bg-elevated", "--ghost"),
            ("--s-text-primary", "--ink"),
            ("--s-text-secondary", "--txt-2"),
            ("--s-text-muted", "--txt-3"),
            ("--s-accent", "--ctx"),
        ]
        for (sVar, source) in sMappings {
            if let value = tokens[source], Self.isSafeCSSValue(value) {
                lines.append("  \(sVar): \(value);")
            }
        }
        guard !lines.isEmpty else {
            return "html { color-scheme: \(base.rawValue); }"
        }
        return ":root {\n" + lines.joined(separator: "\n")
            + "\n}\nhtml { color-scheme: \(base.rawValue); }"
    }

    private static func isSafeCSSName(_ name: String) -> Bool {
        name.hasPrefix("--") && name.count < 64
            && name.dropFirst(2).allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
    }

    private static func isSafeCSSValue(_ value: String) -> Bool {
        value.count < 128
            && value.allSatisfy {
                $0.isLetter || $0.isNumber || " #.,%()-/".contains($0)
            }
    }
}
