import SwiftUI

/// The shell has the same two layout modes as the web follower: an overlay at
/// narrow widths and a side-by-side split when regular width has enough room.
enum ShellLayoutMode: CaseIterable, Equatable, Sendable {
    case compactOverlay
    case regularSplit
}

/// Pure shell layout selection, independent of device idiom.
enum ShellLayout {
    /// Mirrors the web shell's `@media (max-width: 560px)` boundary.
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
