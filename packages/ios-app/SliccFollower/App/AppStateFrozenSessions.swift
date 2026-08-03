import Foundation

/// The freezer rail: browsing and opening the leader's saved (frozen)
/// sessions read-only.
///
/// Split out of `AppState` because the class had grown past its size budget
/// and this is its most self-contained subsystem — it talks only to the VFS
/// client and its own published state, never to the transport.
extension AppState {

    /// How the frozen-session list was (or failed to be) produced.
    enum FrozenListState: Equatable {
        case idle
        case loading
        /// `rebuilt` means /sessions/index.json was corrupt and the list came
        /// from a /sessions directory scan instead.
        case loaded(rebuilt: Bool)
        case failed(String)
    }

    struct OpenFrozenSession {
        let entry: FrozenSessionIndexEntry
        let archive: ParsedFrozenArchive
    }

    /// Load `/sessions/index.json` from the leader's VFS. A corrupt index
    /// self-heals from a `/sessions` directory scan; a missing sessions dir
    /// is an empty rail, not an error.
    func loadFrozenSessions() {
        #if DEBUG
            if let fixture = UITestHooks.frozenFixture() {
                frozenSessions = fixture
                frozenListState = .loaded(rebuilt: false)
                return
            }
        #endif
        guard connectionState == .connected else {
            // The snowflake is always reachable; a stale list from a previous
            // leader — or an eternal spinner from `.idle` — must not be.
            frozenSessions = []
            frozenListState = .failed("Connect to a leader to browse its past sessions.")
            return
        }
        frozenListState = .loading
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let raw = try await self.fsClient.readFile(FrozenSessionIndex.indexPath)
                if let entries = FrozenSessionIndex.parse(indexJson: raw) {
                    self.frozenSessions = entries
                    self.frozenListState = .loaded(rebuilt: false)
                    return
                }
                // Corrupt or partially written index — rebuild from a scan.
                try await self.rebuildFrozenList()
            } catch {
                // Missing index but present archives is the same self-heal
                // path; a missing directory degrades to an empty rail.
                do {
                    try await self.rebuildFrozenList()
                } catch {
                    self.frozenSessions = []
                    self.frozenListState = .loaded(rebuilt: false)
                }
            }
        }
    }

    private func rebuildFrozenList() async throws {
        let entries = try await fsClient.readDir(FrozenSessionIndex.sessionsDir)
        frozenSessions = FrozenSessionIndex.rebuild(from: entries)
        frozenListState = .loaded(rebuilt: true)
    }

    /// Open one archive read-only. Never logs the content; parse failures
    /// surface on `frozenOpenError`.
    func openFrozenSession(_ entry: FrozenSessionIndexEntry) {
        frozenOpenError = nil
        #if DEBUG
            if let markdown = UITestHooks.frozenArchiveFixture(for: entry) {
                openFrozen = OpenFrozenSession(
                    entry: entry,
                    archive: FrozenArchiveParser.withFallbackTimestamps(
                        FrozenArchiveParser.parse(markdown: markdown),
                        frozenAt: entry.frozenDate))
                return
            }
        #endif
        frozenOpeningId = entry.id
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.frozenOpeningId = nil }
            do {
                let markdown = try await self.fsClient.readFile(entry.path)
                self.openFrozen = OpenFrozenSession(
                    entry: entry,
                    archive: FrozenArchiveParser.withFallbackTimestamps(
                        FrozenArchiveParser.parse(markdown: markdown),
                        frozenAt: entry.frozenDate))
            } catch {
                self.frozenOpenError =
                    "Could not read “\(entry.title)” — it may have been removed on the leader."
            }
        }
    }

    func closeFrozenSession() {
        openFrozen = nil
    }
}
