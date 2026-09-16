import Foundation
import os

extension AppState {
    private static let themeLogger = Logger(
        subsystem: "com.slicc.follower", category: "AppState")

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
