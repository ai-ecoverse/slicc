import Foundation
import Darwin

/// Headless updater driver. When the Sliccstart binary is invoked with
/// `--probe-update`, the entry point hands control here instead of
/// bringing up SwiftUI. The probe wires the same modules SliccstartApp
/// uses (`UpdateHostConfiguration`, `ReleaseAssetResolver`,
/// `UpdateManifestFetcher`, `SmoothUpdateCoordinator`, `WebappOverlayStore`)
/// against the live host and prints a JSON summary of the resulting
/// coordinator state to stdout.
///
/// This exists so the test target can drive the **shipping binary** as a
/// subprocess instead of only exercising the modules in-process. Past
/// updater regressions hid behind the wiring layer (which url? which
/// header? which exit code?), so the integration test launches the same
/// binary users run and asserts on its output.
enum UpdateProbeCommand {

    /// If `--probe-update` is present in argv, run the probe and exit.
    /// Otherwise return so the normal SwiftUI entry point can continue.
    ///
    /// Implementation note: the coordinator is `@MainActor`, so we
    /// schedule a main-actor `Task` and then spin the main run loop.
    /// The task calls `exit()` itself once it has emitted the JSON
    /// summary — blocking the main thread on a semaphore instead would
    /// starve the main actor and deadlock.
    static func runIfRequested() {
        let args = CommandLine.arguments
        guard args.contains("--probe-update") else { return }
        let environment = ProcessInfo.processInfo.environment
        Task { @MainActor in
            let code = await execute(arguments: args, environment: environment)
            fflush(stdout)
            Darwin.exit(code)
        }
        RunLoop.main.run()
    }

    // MARK: - Argument parsing

    struct ProbeOptions {
        var host: UpdateHostConfiguration
        var owner: String = "ai-ecoverse"
        var repo: String = "slicc"
        var releasePrefix: String = "Sliccstart"
        var overlayRoot: URL
        var runningSliccstartHash: String
        var runningServerHash: String
        var runningWebappHash: String
        /// `detect` stops after `coordinator.check`; `apply` continues
        /// through `applyWebappOnly` when the coordinator picks that path.
        var mode: Mode = .detect

        enum Mode: String { case detect, apply }
    }

    enum ProbeError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let key): return "missing required arg --\(key)"
            }
        }
    }

    static func parse(arguments: [String], environment: [String: String]) throws -> ProbeOptions {
        // `UpdateHostConfiguration.resolve` already understands both
        // `--update-host=<url>` and the `SLICC_UPDATE_HOST` env var.
        let host = UpdateHostConfiguration.resolve(arguments: arguments, environment: environment)

        func value(for key: String) -> String? {
            for (i, a) in arguments.enumerated() {
                if a == "--\(key)", i + 1 < arguments.count { return arguments[i + 1] }
                let prefix = "--\(key)="
                if a.hasPrefix(prefix) { return String(a.dropFirst(prefix.count)) }
            }
            return nil
        }

        guard let overlayRoot = value(for: "overlay-root") else { throw ProbeError.missing("overlay-root") }
        guard let runSlicc = value(for: "running-sliccstart-hash") else { throw ProbeError.missing("running-sliccstart-hash") }
        guard let runServer = value(for: "running-server-hash") else { throw ProbeError.missing("running-server-hash") }
        guard let runWebapp = value(for: "running-webapp-hash") else { throw ProbeError.missing("running-webapp-hash") }

        var options = ProbeOptions(
            host: host,
            overlayRoot: URL(fileURLWithPath: overlayRoot, isDirectory: true),
            runningSliccstartHash: runSlicc,
            runningServerHash: runServer,
            runningWebappHash: runWebapp
        )
        if let owner = value(for: "owner") { options.owner = owner }
        if let repo = value(for: "repo") { options.repo = repo }
        if let prefix = value(for: "release-prefix") { options.releasePrefix = prefix }
        if let modeRaw = value(for: "mode"), let mode = ProbeOptions.Mode(rawValue: modeRaw) {
            options.mode = mode
        }
        return options
    }

    // MARK: - Execution

    @MainActor
    static func execute(arguments: [String], environment: [String: String]) async -> Int32 {
        let options: ProbeOptions
        do {
            options = try parse(arguments: arguments, environment: environment)
        } catch {
            emit(["error": "\(error)"])
            return 2
        }

        // Real URLSession-backed downloaders, identical to what
        // SliccstartApp ships with — that's the whole point of this
        // probe: it tests the live network path.
        let downloader: (URL) async throws -> Data = { url in
            var request = URLRequest(url: url)
            request.timeoutInterval = 10
            if let token = environment["GH_TOKEN"], !token.isEmpty {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }
            return data
        }

        let resolver = ReleaseAssetResolver(host: options.host, download: downloader)
        let locator: ReleaseAssetLocator?
        do {
            locator = try await resolver.resolveLatest(
                owner: options.owner,
                repo: options.repo,
                releasePrefix: options.releasePrefix
            )
        } catch {
            emit(["state": "failed", "stage": "resolve", "error": "\(error.localizedDescription)"])
            return 1
        }

        guard let release = locator else {
            emit(["state": "noRelease"])
            return 0
        }

        let overlayStore = WebappOverlayStore(rootDirectory: options.overlayRoot)
        let runningHashes = RunningAppHashes(
            sliccstart: options.runningSliccstartHash,
            sliccServer: options.runningServerHash,
            webapp: options.runningWebappHash
        )
        let coordinator = SmoothUpdateCoordinator(
            manifestFetcher: UpdateManifestFetcher(download: downloader),
            assetDownloader: { url, destination in
                let data = try await downloader(url)
                try data.write(to: destination, options: .atomic)
            },
            overlayStore: overlayStore,
            hashesProvider: { runningHashes }
        )
        let state = await coordinator.check(
            manifestURL: release.manifestURL,
            webappAssetURL: release.webappAssetURL
        )

        if options.mode == .detect {
            emit(snapshot(state: state, overlayStore: overlayStore, respawnCount: 0))
            return 0
        }

        guard case .webappOnlyAvailable(let version, let assetURL, let hash) = state else {
            emit(snapshot(state: state, overlayStore: overlayStore, respawnCount: 0))
            return 0
        }

        var respawnCount = 0
        await coordinator.applyWebappOnly(
            version: version,
            assetURL: assetURL,
            manifestWebappHash: hash,
            respawn: { respawnCount += 1 }
        )
        emit(snapshot(state: coordinator.state, overlayStore: overlayStore, respawnCount: respawnCount))
        return 0
    }

    @MainActor
    private static func snapshot(
        state: SmoothUpdateCoordinator.State,
        overlayStore: WebappOverlayStore,
        respawnCount: Int
    ) -> [String: Any] {
        var payload: [String: Any] = ["respawnCount": respawnCount]
        switch state {
        case .idle: payload["state"] = "idle"
        case .checking: payload["state"] = "checking"
        case .noUpdate: payload["state"] = "noUpdate"
        case .fullUpdateRequired(let v):
            payload["state"] = "fullUpdateRequired"
            payload["version"] = v
        case .webappOnlyAvailable(let v, let url, let hash):
            payload["state"] = "webappOnlyAvailable"
            payload["version"] = v
            payload["assetURL"] = url.absoluteString
            payload["expectedHash"] = hash
        case .applying(let v, let progress):
            payload["state"] = "applying"
            payload["version"] = v
            payload["progress"] = progress
        case .applied(let v):
            payload["state"] = "applied"
            payload["version"] = v
        case .failed(let message):
            payload["state"] = "failed"
            payload["error"] = message
        }
        if let active = overlayStore.activeOverlayPath() {
            payload["overlayPath"] = active
        }
        if let version = overlayStore.activeVersion() {
            payload["activeOverlayVersion"] = version
        }
        return payload
    }

    private static func emit(_ payload: [String: Any]) {
        // JSON-encode so the test can parse the result without lexing
        // free-form log output. Stable key set above.
        let data = (try? JSONSerialization.data(
            withJSONObject: payload,
            options: [.sortedKeys]
        )) ?? Data()
        if let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    }
}


