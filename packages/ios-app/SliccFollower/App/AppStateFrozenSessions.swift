import Foundation

extension AppState {

    enum FrozenListState: Equatable {
        case idle
        case loading

        case loaded(rebuilt: Bool)
        case failed(String)
    }

    struct OpenFrozenSession {
        let entry: FrozenSessionIndexEntry
        let archive: ParsedFrozenArchive
    }

    func loadFrozenSessions() {
        #if DEBUG
            if let fixture = UITestHooks.frozenFixture() {
                frozenSessions = fixture
                frozenListState = .loaded(rebuilt: false)
                return
            }
        #endif
        guard connectionState == .connected else {

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

                try await self.rebuildFrozenList()
            } catch {

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
