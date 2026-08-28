import Foundation
import SliccTrayKit

// MARK: - Transcript file mentions

extension AppState {
    /// Whether the leader has a file at `path` — the single probe behind
    /// `FileMentionResolver`.
    ///
    /// Deliberately the ONLY question the follower asks. The browser resolves a
    /// bare `check.js` by walking its own VFS and indexing basenames; here every
    /// step of a walk is an `fs.request` over the data channel, so the follower
    /// stats exactly one candidate per mention and lets the rest stay plain
    /// text.
    ///
    /// A disconnected follower answers `false` rather than queueing: `FsClient`
    /// would hold the request until its 30-second timeout, and a mention that
    /// links a reconnect later is worse than one that never links at all.
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
