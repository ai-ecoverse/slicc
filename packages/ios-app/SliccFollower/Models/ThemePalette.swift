import SwiftUI
















struct ThemePalette: Equatable {
    
    let canvas: Color
    
    let surface: Color
    
    let field: Color
    
    let ink: Color
    
    let inkSecondary: Color
    
    let inkTertiary: Color
    
    let line: Color
    
    let accent: Color
    
    let bubble: Color
    
    
    
    let bubbleText: Color
    
    
    let isLeaderTheme: Bool

    
    
    static let dark = ThemePalette(
        canvas: Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255),
        surface: Color(red: 0x1C / 255, green: 0x1C / 255, blue: 0x2E / 255),
        field: Color(white: 1, opacity: 0.07),
        ink: .white,
        inkSecondary: Color.white.opacity(0.7),
        inkTertiary: Color.white.opacity(0.5),
        line: Color(white: 1, opacity: 0.1),
        accent: Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255),
        
        
        bubble: Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255),
        bubbleText: .white,
        isLeaderTheme: false
    )

    
    static let light = ThemePalette(
        canvas: Color(hexToken: "#ffffff") ?? .white,
        surface: Color(hexToken: "#f4f4f6") ?? .white,
        field: Color(hexToken: "#ececef") ?? .white,
        ink: Color(hexToken: "#0a0a0a") ?? .black,
        inkSecondary: Color(hexToken: "#737373") ?? .gray,
        inkTertiary: Color(hexToken: "#a1a1a1") ?? .gray,
        line: Color(hexToken: "#e5e5e5") ?? .gray,
        accent: Color(red: 0x71 / 255, green: 0x55 / 255, blue: 0xFA / 255),
        
        bubble: Color(hexToken: "#000000") ?? .black,
        bubbleText: .white,
        isLeaderTheme: false
    )

    
    
    
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



private struct ThemePaletteKey: EnvironmentKey {
    static let defaultValue = ThemePalette.dark
}

extension EnvironmentValues {
    
    
    var palette: ThemePalette {
        get { self[ThemePaletteKey.self] }
        set { self[ThemePaletteKey.self] = newValue }
    }
}



private struct SprinkleThemeCSSKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    
    
    
    var sprinkleThemeCSS: String {
        get { self[SprinkleThemeCSSKey.self] }
        set { self[SprinkleThemeCSSKey.self] = newValue }
    }
}

extension SliccTheme {
    
    
    
    
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

    
    
    private func deviceSprinkleCSS(colorScheme: Base) -> String {
        let surfaces = colorScheme == .light ? Self.lightDeviceSurfaces : Self.darkDeviceSurfaces
        var lines = surfaces.map { "  \($0.0): \($0.1);" }
        if let ctx = tokens["--ctx"], Self.isSafeCSSValue(ctx) {
            lines.append("  --ctx: \(ctx);")
            lines.append("  --s-accent: \(ctx);")
        }
        return Self.sprinkleCSSBlock(lines: lines, colorScheme: colorScheme, paintBody: true)
    }

    
    
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
