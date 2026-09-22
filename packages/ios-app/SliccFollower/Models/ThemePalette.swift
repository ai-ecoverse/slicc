import SwiftUI

/// The resolved native palette views render from, injected through the
/// SwiftUI environment (`\.palette`) so no view hardcodes hex again.
///
/// The device owns light and dark. A leader theme (`theme.apply`) still
/// supplies color, in this order:
/// 1. Theme `base` matches the device — token map + `base`. Raw `css` and
///    per-component overrides are ignored: injecting arbitrary CSS into
///    native views is not meaningful, and the web side sanitizes it
///    precisely because it is dangerous.
/// 2. Theme `base` is the other appearance — the device's surfaces, with
///    the theme's `--ctx` accent kept. A dark theme must not paint a
///    light phone dark.
/// 3. No theme — the device's light or dark default. Dark is the app's
///    existing hand-tuned look; light is the webapp's canonical tokens
///    (`packages/webcomponents/src/theme/tokens.css`).
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

    /// Device surfaces plus the leader accent. `--ctx` wins when it parses;
    /// an unparseable or missing accent keeps the device default.
    func withLeaderAccent(_ theme: SliccTheme) -> ThemePalette {
        let nextAccent: Color
        if let raw = theme.tokens["--ctx"], let parsed = Color(hexToken: raw) {
            nextAccent = parsed
        } else {
            nextAccent = accent
        }
        return ThemePalette(
            canvas: canvas,
            surface: surface,
            field: field,
            ink: ink,
            inkSecondary: inkSecondary,
            inkTertiary: inkTertiary,
            line: line,
            accent: nextAccent,
            bubble: bubble,
            bubbleText: bubbleText,
            isLeaderTheme: true
        )
    }

    /// The palette for the current state. Light/dark follows the device.
    /// A leader theme contributes its full token palette when `base`
    /// matches that appearance, and only its accent otherwise.
    static func resolve(theme: SliccTheme?, systemScheme: ColorScheme) -> ThemePalette {
        let device = systemScheme == .light ? light : dark
        guard let theme else { return device }
        let themeIsLight = theme.base == .light
        let deviceIsLight = systemScheme == .light
        if themeIsLight == deviceIsLight { return fromTheme(theme) }
        return device.withLeaderAccent(theme)
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
    /// Device surfaces for a sprinkle whose leader theme was authored for
    /// the other appearance. Hexes match `ThemePalette.light` / `.dark`
    /// (and the inline card steps the dark stylesheet already ships) so a
    /// dark theme cannot leave `--s-*` and `html, body` painted dark.
    private static let lightDeviceSurfaces: [(String, String)] = [
        ("--canvas", "#ffffff"),
        ("--bg", "#f4f4f6"),
        ("--ghost", "#ececef"),
        ("--ink", "#0a0a0a"),
        ("--txt-2", "#737373"),
        ("--txt-3", "#a1a1a1"),
        ("--line", "#e5e5e5"),
        ("--s-bg-card", "#f4f4f6"),
        ("--s-bg-card-soft", "#ececef"),
        ("--s-bg-elevated", "#ececef"),
        ("--s-text-primary", "#0a0a0a"),
        ("--s-text-secondary", "#737373"),
        ("--s-text-muted", "#a1a1a1"),
    ]

    private static let darkDeviceSurfaces: [(String, String)] = [
        ("--canvas", "#0f0f1a"),
        ("--bg", "#1c1c2e"),
        ("--ghost", "#1f1f38"),
        ("--ink", "#ffffff"),
        ("--txt-2", "#b3b3b3"),
        ("--txt-3", "#808080"),
        ("--line", "#2e2e3a"),
        ("--s-bg-card", "#1c1c2e"),
        ("--s-bg-card-soft", "#1f1f38"),
        ("--s-bg-elevated", "#25254a"),
        ("--s-text-primary", "#ffffff"),
        ("--s-text-secondary", "#b3b3b3"),
        ("--s-text-muted", "#808080"),
    ]

    /// CSS injected into sprinkle WKWebViews. When `scheme` matches `base`,
    /// the raw token map goes in verbatim (full sprinkle documents read the
    /// webapp names like `--canvas`) plus the `--s-*` mappings iOS's own
    /// inline-sprinkle wrapper CSS reads. When it does not, the device's
    /// surface and text tokens replace the wrapper's dark defaults, and the
    /// only leader color kept is `--ctx` (copied to `--s-accent`). Values
    /// come off the wire, so both names and values pass a strict character
    /// allowlist — a token can never close the style block or smuggle
    /// markup. Raw theme `css` deliberately never crosses this boundary.
    func sprinkleCSSOverrides(for scheme: ColorScheme) -> String {
        let deviceBase: Base = scheme == .light ? .light : .dark
        if deviceBase == base {
            return fullSprinkleCSS(colorScheme: deviceBase)
        }
        return deviceSprinkleCSS(colorScheme: deviceBase)
    }

    private func fullSprinkleCSS(colorScheme: Base) -> String {
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
        return Self.sprinkleCSSBlock(lines: lines, colorScheme: colorScheme, paintBody: false)
    }

    /// Surfaces from the device palette. Leader tokens other than a safe
    /// `--ctx` are dropped, including semantic colors tuned for the other base.
    private func deviceSprinkleCSS(colorScheme: Base) -> String {
        let surfaces = colorScheme == .light ? Self.lightDeviceSurfaces : Self.darkDeviceSurfaces
        var lines = surfaces.map { "  \($0.0): \($0.1);" }
        if let ctx = tokens["--ctx"], Self.isSafeCSSValue(ctx) {
            lines.append("  --ctx: \(ctx);")
            lines.append("  --s-accent: \(ctx);")
        }
        return Self.sprinkleCSSBlock(lines: lines, colorScheme: colorScheme, paintBody: true)
    }

    /// `paintBody` overrides SprinkleWebView's literal `background:#0F0F1A`.
    /// `color-scheme` alone does not replace that declaration.
    private static func sprinkleCSSBlock(
        lines: [String], colorScheme: Base, paintBody: Bool
    ) -> String {
        let schemeName = colorScheme.rawValue
        let bodyRule =
            paintBody
            ? "html, body { background: var(--canvas); color: var(--ink); }\n"
            : ""
        guard !lines.isEmpty else {
            return bodyRule + "html { color-scheme: \(schemeName); }"
        }
        return ":root {\n" + lines.joined(separator: "\n")
            + "\n}\n" + bodyRule + "html { color-scheme: \(schemeName); }"
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
