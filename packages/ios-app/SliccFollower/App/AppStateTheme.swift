import Foundation
import os

/// Leader-theme handling (`theme.apply`), separated from the main type body
/// so the connection coordinator stays under the lint size cap.
extension AppState {
    private static let themeLogger = Logger(
        subsystem: "com.slicc.follower", category: "AppState")

    /// Decode and publish a `theme.apply` payload. `nil` resets to the
    /// system scheme, as does undecodable JSON (loudly). Only `base` and
    /// `tokens` drive native rendering: raw `css` and per-component
    /// overrides are deliberately ignored — injecting arbitrary CSS into
    /// native views is not meaningful, and the web side sanitizes it
    /// precisely because it is dangerous.
    func applyLeaderTheme(_ themeJson: String?) {
        guard let themeJson else {
            leaderTheme = nil
            return
        }
        guard let data = themeJson.data(using: .utf8),
            let theme = try? JSONDecoder().decode(SliccTheme.self, from: data)
        else {
            Self.themeLogger.warning(
                "theme.apply JSON undecodable — resetting to the system scheme")
            leaderTheme = nil
            return
        }
        leaderTheme = theme
    }
}
