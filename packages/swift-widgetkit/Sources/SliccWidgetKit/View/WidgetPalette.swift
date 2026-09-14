import SwiftUI














public struct WidgetPalette: Equatable, Sendable {
    public let canvas: Color
    public let ink: Color
    public let inkSecondary: Color
    public let inkTertiary: Color
    
    
    public let cone: Color
    
    public let warn: Color

    public static let light = WidgetPalette(
        canvas: Color(hex: 0xFFFFFF),
        ink: Color(hex: 0x0A0A0A),
        inkSecondary: Color(hex: 0x737373),
        inkTertiary: Color(hex: 0xA1A1A1),
        cone: Color(hex: 0xB07823),
        warn: Color(hex: 0xF59E0B)
    )

    
    
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

    
    
    public func connectionColor(_ connection: WidgetSnapshot.Connection) -> Color? {
        switch connection {
        case .connected: nil
        case .stalled: warn
        case .disconnected, .none: inkTertiary
        }
    }
}

extension WidgetPalette {
    
    
    
    public func avatarHue(for unit: WidgetUnit) -> Color {
        Color(cssHex: unit.avatarColorHex) ?? cone
    }
}

extension Color {
    
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
