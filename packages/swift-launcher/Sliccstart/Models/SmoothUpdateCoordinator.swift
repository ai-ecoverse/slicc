import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "SmoothUpdate")

/// Drives the "is the new release UI-only?" decision and the live apply
/// of a webapp overlay. Pulled out of `SliccstartApp` so it can be tested
/// without SwiftUI.
@MainActor
@Observable
final class SmoothUpdateCoordinator {
    enum State: Equatable {
        case idle
        case checking
        case noUpdate
        /// Manifest available but binaries differ — caller must fall back
        /// to the full AppUpdater zip flow.
        case fullUpdateRequired(version: String)
        /// Manifest available and binaries match — the launcher can apply
        /// the webapp overlay live. `hash` is the expected sha256 of the
        /// unpacked overlay so the apply step can refuse to activate a
        /// corrupted/tampered download.
        case webappOnlyAvailable(version: String, assetURL: URL, hash: String)
        case applying(version: String, progress: String)
        case applied(version: String)
        case failed(message: String)
    }

    var state: State = .idle

    private let manifestFetcher: UpdateManifestFetcher
    private let assetDownloader: (URL, URL) async throws -> Void
    private let overlayStore: WebappOverlayStore
    private let hashesProvider: () throws -> RunningAppHashes

    init(
        manifestFetcher: UpdateManifestFetcher = .default,
        assetDownloader: @escaping (URL, URL) async throws -> Void = defaultAssetDownloader,
        overlayStore: WebappOverlayStore = WebappOverlayStore(),
        hashesProvider: @escaping () throws -> RunningAppHashes = { try RunningAppHashes.compute() }
    ) {
        self.manifestFetcher = manifestFetcher
        self.assetDownloader = assetDownloader
        self.overlayStore = overlayStore
        self.hashesProvider = hashesProvider
    }

    /// Inspect a freshly-fetched manifest. The caller (typically the
    /// AppUpdater "downloadedAppBundle" code path) passes the resolved
    /// manifest URL + asset base URL for the webapp zip.
    func evaluate(manifest: UpdateManifest, webappAssetURL: URL) {
        do {
            let hashes = try hashesProvider()
            switch manifest.compare(toRunningHashes: hashes) {
            case .noChange:
                state = .noUpdate
            case .fullApp:
                state = .fullUpdateRequired(version: manifest.version)
            case .webappOnly:
                state = .webappOnlyAvailable(
                    version: manifest.version,
                    assetURL: webappAssetURL,
                    hash: manifest.webapp
                )
            }
        } catch {
            log.error("evaluate: hash computation failed: \(error.localizedDescription, privacy: .public)")
            state = .failed(message: error.localizedDescription)
        }
    }

    /// Fetch the manifest, compare, and place the coordinator in the
    /// appropriate state. Returns the resolved state for the caller's
    /// convenience.
    @discardableResult
    func check(manifestURL: URL, webappAssetURL: URL) async -> State {
        state = .checking
        do {
            let manifest = try await manifestFetcher.fetch(from: manifestURL)
            evaluate(manifest: manifest, webappAssetURL: webappAssetURL)
        } catch {
            log.error("check: \(error.localizedDescription, privacy: .public)")
            state = .failed(message: error.localizedDescription)
        }
        return state
    }

    /// Apply a webapp-only update: download zip, unpack into overlay,
    /// flip the active pointer, then ask the caller to respawn running
    /// slicc-servers via the provided closure (so this type doesn't
    /// depend on SliccProcess directly).
    func applyWebappOnly(
        version: String,
        assetURL: URL,
        manifestWebappHash: String,
        respawn: () async -> Void
    ) async {
        state = .applying(version: version, progress: "Downloading webapp…")
        do {
            let zipURL = try overlayStore.zipPath(for: version)
            try await assetDownloader(assetURL, zipURL)

            state = .applying(version: version, progress: "Installing overlay…")
            let overlayDir = try overlayStore.install(zipURL: zipURL, version: version)

            // Verify the downloaded overlay matches the manifest hash —
            // otherwise we trust an unverified asset to back the UI.
            let actualHash = try sha256Directory(at: overlayDir)
            guard actualHash == manifestWebappHash else {
                throw SmoothUpdateError.hashMismatch(expected: manifestWebappHash, actual: actualHash)
            }

            try overlayStore.setActive(version: version)
            overlayStore.pruneOthers(keep: version)

            state = .applying(version: version, progress: "Restarting runtimes…")
            await respawn()
            state = .applied(version: version)
        } catch {
            log.error("applyWebappOnly: \(error.localizedDescription, privacy: .public)")
            state = .failed(message: error.localizedDescription)
        }
    }

}

/// Default downloader used by `SmoothUpdateCoordinator`. Defined at file
/// scope so it isn't main-actor isolated (the coordinator itself is).
nonisolated func defaultAssetDownloader(_ url: URL, _ destination: URL) async throws {
    var request = URLRequest(url: url)
    request.timeoutInterval = 60
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse,
          (200..<300).contains(httpResponse.statusCode) else {
        throw URLError(.badServerResponse)
    }
    try data.write(to: destination, options: .atomic)
}

enum SmoothUpdateError: LocalizedError {
    case hashMismatch(expected: String, actual: String)

    var errorDescription: String? {
        switch self {
        case .hashMismatch(let expected, let actual):
            return "Webapp hash mismatch — expected \(expected) but got \(actual). Refusing to activate."
        }
    }
}
