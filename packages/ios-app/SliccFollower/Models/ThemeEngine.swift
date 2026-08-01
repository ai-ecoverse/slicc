import Foundation

/// Swift mirror of the leader's theme system — `SliccTheme`
/// (`packages/webapp/src/ui/theme-types.ts`) and the token derivation
/// (`deriveTokens` in `packages/webapp/src/ui/theme-engine.ts`). The HSL
/// math is ported line-for-line and pinned against generated fixtures
/// (`Fixtures/theme-vectors.json`, from gen-theme-vectors.mjs) so the two
/// implementations cannot diverge silently.

/// A leader theme as carried by `theme.apply`. Only `base` and `tokens`
/// drive native rendering; unknown fields (per-component overrides) are
/// ignored on decode — iOS never re-encodes a theme.
struct SliccTheme: Codable, Equatable {
    enum Base: String, Codable {
        case dark, light
    }

    let id: String
    let name: String
    let author: String?
    let base: Base
    let tokens: [String: String]
    let disableShader: Bool?
    let css: String?

    init(
        id: String,
        name: String,
        author: String? = nil,
        base: Base,
        tokens: [String: String],
        disableShader: Bool? = nil,
        css: String? = nil
    ) {
        self.id = id
        self.name = name
        self.author = author
        self.base = base
        self.tokens = tokens
        self.disableShader = disableShader
        self.css = css
    }
}

/// The 7 simplified slots a theme editor exposes; `deriveTokens` expands
/// them into the full CSS-variable map.
struct ThemeSlots: Codable, Equatable {
    let background: String
    let surface: String
    let text: String
    let accent: String
    let border: String
    let success: String
    let error: String
}

enum ThemeEngine {
    /// Port of `hexToHsl` — h in 0-360, s and l in 0-1. Expects `#rrggbb`.
    static func hexToHsl(_ hex: String) -> (h: Double, s: Double, l: Double) {
        func channel(_ start: Int) -> Double {
            let from = hex.index(hex.startIndex, offsetBy: start)
            let to = hex.index(from, offsetBy: 2)
            return Double(Int(hex[from..<to], radix: 16) ?? 0) / 255
        }
        let r = channel(1)
        let g = channel(3)
        let b = channel(5)

        let maxC = max(r, g, b)
        let minC = min(r, g, b)
        let l = (maxC + minC) / 2

        if maxC == minC { return (0, 0, l) }

        let d = maxC - minC
        let s = l > 0.5 ? d / (2 - maxC - minC) : d / (maxC + minC)

        let h: Double
        if maxC == r {
            h = ((g - b) / d + (g < b ? 6 : 0)) * 60
        } else if maxC == g {
            h = ((b - r) / d + 2) * 60
        } else {
            h = ((r - g) / d + 4) * 60
        }
        return (h, s, l)
    }

    /// Port of `hslToHex` (h 0-360, s/l 0-1) back to `#rrggbb`.
    static func hslToHex(_ h: Double, _ s: Double, _ l: Double) -> String {
        func hue2rgb(_ p: Double, _ q: Double, _ t0: Double) -> Double {
            var t = t0
            if t < 0 { t += 1 }
            if t > 1 { t -= 1 }
            if t < 1 / 6 { return p + (q - p) * 6 * t }
            if t < 1 / 2 { return q }
            if t < 2 / 3 { return p + (q - p) * (2 / 3 - t) * 6 }
            return p
        }

        let r: Double
        let g: Double
        let b: Double
        if s == 0 {
            r = l
            g = l
            b = l
        } else {
            let q = l < 0.5 ? l * (1 + s) : l + s - l * s
            let p = 2 * l - q
            let hNorm = h / 360
            r = hue2rgb(p, q, hNorm + 1 / 3)
            g = hue2rgb(p, q, hNorm)
            b = hue2rgb(p, q, hNorm - 1 / 3)
        }

        func toHex(_ v: Double) -> String {
            // JS Math.round: half rounds toward +∞; for the 0…255 domain
            // Swift's .rounded() (half away from zero) agrees.
            String(format: "%02x", Int((v * 255).rounded()))
        }
        return "#\(toHex(r))\(toHex(g))\(toHex(b))"
    }

    static func adjustLightness(_ hex: String, _ delta: Double) -> String {
        let (h, s, l) = hexToHsl(hex)
        return hslToHex(h, s, max(0, min(1, l + delta)))
    }

    static func adjustSaturation(_ hex: String, _ delta: Double) -> String {
        let (h, s, l) = hexToHsl(hex)
        return hslToHex(h, max(0, min(1, s + delta)), l)
    }

    /// Port of `deriveTokens` — the full map, in lockstep with the TS
    /// implementation (fixture-pinned). iOS renders only a subset, but
    /// deriving everything keeps the parity check total.
    static func deriveTokens(slots: ThemeSlots, base: SliccTheme.Base) -> [String: String] {
        let isDark = base == .dark
        let step: Double = isDark ? 0.03 : -0.02

        var t: [String: String] = [:]

        // Surfaces
        t["--s2-gray-25"] = slots.background
        t["--s2-bg-base"] = slots.background
        t["--s2-gray-50"] = adjustLightness(slots.background, step)
        t["--s2-gray-75"] = adjustLightness(slots.background, step * 2)
        t["--s2-gray-100"] = adjustLightness(slots.background, step * 3)
        t["--s2-gray-200"] = adjustLightness(slots.background, step * 5)
        t["--s2-bg-sunken"] = adjustLightness(slots.background, isDark ? -0.02 : 0.02)
        t["--s2-bg-layer-1"] = adjustLightness(slots.background, step)
        t["--s2-bg-layer-2"] = adjustLightness(slots.background, step * 2)
        t["--s2-bg-elevated"] = adjustLightness(slots.background, step * 3)

        // Surface slot directly
        t["--s2-gray-300"] = slots.surface

        // Text
        t["--s2-gray-900"] = slots.text
        t["--s2-gray-1000"] = isDark ? "#ffffff" : "#000000"
        t["--s2-gray-800"] = adjustLightness(slots.text, isDark ? -0.05 : 0.05)
        t["--s2-content-default"] = slots.text
        t["--s2-content-secondary"] = adjustLightness(slots.text, isDark ? -0.1 : 0.1)
        t["--s2-content-tertiary"] = adjustLightness(slots.text, isDark ? -0.2 : 0.2)
        t["--s2-content-disabled"] = adjustLightness(slots.text, isDark ? -0.3 : 0.3)

        // Accents
        t["--s2-accent"] = slots.accent
        t["--s2-accent-hover"] = adjustLightness(slots.accent, isDark ? 0.08 : -0.06)
        t["--s2-accent-down"] = adjustLightness(slots.accent, isDark ? -0.06 : 0.08)
        t["--slicc-accent"] = slots.accent
        t["--slicc-cone"] = slots.accent
        t["--slicc-scoop-blue"] = adjustSaturation(slots.accent, 0.1)
        t["--slicc-scoop-purple"] = adjustLightness(slots.accent, 0.05)
        t["--slicc-scoop-teal"] = adjustLightness(slots.accent, -0.05)

        // Semantic
        t["--s2-positive"] = slots.success
        t["--s2-negative"] = slots.error
        t["--s2-informative"] = slots.accent
        t["--s2-notice"] = adjustLightness(slots.accent, isDark ? 0.1 : -0.1)

        // Chrome
        t["--s2-border-default"] = slots.border
        t["--s2-border-subtle"] = adjustLightness(slots.border, isDark ? -0.03 : 0.03)
        t["--s2-border-focus"] = slots.accent
        t["--s2-shadow-elevated"] = isDark ? "rgba(0, 0, 0, 0.4)" : "rgba(0, 0, 0, 0.1)"
        t["--s2-shadow-container"] = isDark ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.05)"

        // WC shell tokens
        t["--canvas"] = slots.background
        t["--bg"] = adjustLightness(slots.background, isDark ? -0.02 : 0.02)
        t["--ghost"] = adjustLightness(slots.background, step * 2)
        t["--desk"] = adjustLightness(slots.background, step * 2)
        t["--ink"] = slots.text
        t["--deep"] = slots.text
        t["--txt-2"] = adjustLightness(slots.text, isDark ? -0.2 : 0.2)
        t["--txt-3"] = adjustLightness(slots.text, isDark ? -0.35 : 0.35)
        t["--line"] = slots.border
        t["--ctx"] = slots.accent
        t["--waffle"] = slots.accent
        t["--shaderbg"] = slots.background

        // Palette tokens
        t["--amber"] = slots.accent
        t["--violet"] = adjustLightness(slots.accent, isDark ? 0.08 : -0.06)
        t["--cyan"] = adjustLightness(slots.accent, isDark ? -0.06 : 0.08)
        t["--rose"] = adjustSaturation(slots.accent, 0.1)
        let gradA = adjustLightness(slots.accent, isDark ? -0.06 : 0.04)
        let gradB = adjustLightness(slots.accent, isDark ? 0.1 : -0.08)
        t["--rainbow"] =
            "linear-gradient(90deg, \(gradA) 0%, \(slots.accent) 50%, \(gradB) 100%)"

        return t
    }
}
