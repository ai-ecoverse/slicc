import Foundation
import SliccTrayKit

extension AppState {

    func transcriptFileExists(_ path: String) async -> Bool {
        guard connectionState == .connected else { return false }
        do {
            _ = try await fsClient.stat(path)
            return true
        } catch {
            return false
        }
    }
}
