import SwiftUI

/// The colours a widget paints with.
///
/// Deliberately NOT `ThemePalette`: a widget cannot receive `theme.apply`, so
/// there is no leader theme to resolve and no environment to inject one
/// through. It follows the system scheme like any other widget on the home
/// screen, off the same token values the web ships
/// (`packages/webcomponents/src/theme/tokens.css`) so an unthemed instance
/// looks like itself on the home screen.
/// Deliberately SMALL. There is no activity palette here: the phase lives in
/// the avatar's face, not in a colour swatch beside it, and a unit's tile
/// colour is its identity hue (`WidgetUnit.avatarColorHex`), not its state. The
/// only colours this type owns are the surface it all sits on and the one hue
/// that flags a link in trouble.
public struct WidgetPalette: Equatable, Sendable {
    public let canvas: Color
    public let ink: Color
    public let inkSecondary: Color
    public let inkTertiary: Color
    /// `--waffle`, the cone's own hue — also the fallback for an unparseable
    /// identity colour.
    public let cone: Color
    /// `--amber` — a stalled leader.
    public let warn: Color

    public static let light = WidgetPalette(
        canvas: Color(hex: 0xFFFFFF),
        ink: Color(hex: 0x0A0A0A),
        inkSecondary: Color(hex: 0x737373),
        inkTertiary: Color(hex: 0xA1A1A1),
        cone: Color(hex: 0xB07823),
        warn: Color(hex: 0xF59E0B)
    )

    /// The web's dark token set. The cone's brown is lifted, not swapped —
    /// the same colour, more luminance, so it survives a dark ground.
    public static let dark = WidgetPalette(
        canvas: Color(hex: 0x161618),
        ink: Color(hex: 0xF5F5F2),
        inkSecondary: Color(hex: 0x9B9BA1),
        inkTertiary: Color(hex: 0x6C6C72),
        cone: Color(hex: 0xD9A24E),
        warn: Color(hex: 0xFBBF24)
    )

    public static func resolve(_ scheme: ColorScheme) -> WidgetPalette {
        scheme == .light ? .light : .dark
    }

    /// Connection pip: a dot the size of a full stop, in the corner. Absent
    /// entirely when connected — a widget that is fine should say nothing.
    public func connectionColor(_ connection: WidgetSnapshot.Connection) -> Color? {
        switch connection {
        case .connected: nil
        case .stalled: warn
        case .disconnected, .none: inkTertiary
        }
    }
}

extension WidgetPalette {
    /// A unit's avatar hue. Parsed from `WidgetUnit.avatarColorHex`, falling
    /// back to the palette's cone brown so a snapshot with a colour this build
    /// cannot parse still paints a tile rather than a hole.
    public func avatarHue(for unit: WidgetUnit) -> Color {
        Color(cssHex: unit.avatarColorHex) ?? cone
    }
}

extension Color {
    /// `#rgb` / `#rrggbb`, the only forms the leader emits.
    init?(cssHex: String) {
        var raw = cssHex.trimmingCharacters(in: .whitespaces)
        guard raw.hasPrefix("#") else { return nil }
        raw.removeFirst()
        if raw.count == 3 {
            raw = raw.map { "\($0)\($0)" }.joined()
        }
        guard raw.count == 6, let value = UInt32(raw, radix: 16) else { return nil }
        self.init(hex: value)
    }

    /// `0xRRGGBB` literals, so the token values above read like the CSS they
    /// were lifted from.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
