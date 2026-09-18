import SwiftUI



enum ShellLayoutMode: CaseIterable, Equatable, Sendable {
    case compactOverlay
    case regularSplit
}


enum ShellLayout {
    
    static let narrowBreakpoint: CGFloat = 560

    static func mode(
        horizontalSizeClass: UserInterfaceSizeClass?,
        availableWidth: CGFloat
    ) -> ShellLayoutMode {
        guard horizontalSizeClass == .regular, availableWidth > narrowBreakpoint else {
            return .compactOverlay
        }
        return .regularSplit
    }
}
