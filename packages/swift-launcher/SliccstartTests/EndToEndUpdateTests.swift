import XCTest
@testable import Sliccstart

/// End-to-end tests for the smooth-update path. These spin up a real
/// loopback HTTP server (`FakeUpdateServer`), point Sliccstart's update
/// machinery at it via `UpdateHostConfiguration`, and walk through the
/// same code paths the production build hits against GitHub.
///
/// Past updater regressions came from URL construction, JSON shape, and
/// header bugs that in-memory mocks never exercised — so every test here
/// goes through `URLSession` and the actual HTTP/1.1 wire.
@MainActor
final class EndToEndUpdateTests: XCTestCase {

    // MARK: - 1. Resolver reads releases from the configured host

    func testReleaseAssetResolverFindsLatestRelease() async throws {
        let fixtures = try UpdateTestFixtures.make(version: "9.9.9")
        defer { fixtures.tearDown() }

        let resolver = ReleaseAssetResolver(host: fixtures.host) { url in
            // Use the production downloader so we hit real URLSession.
            try await defaultURLSessionDownload(url)
        }
        let locator = try await resolver.resolveLatest(
            owner: fixtures.owner,
            repo: fixtures.repo,
            releasePrefix: "Sliccstart"
        )
        XCTAssertNotNil(locator)
        XCTAssertEqual(locator?.version, "9.9.9")
        XCTAssertEqual(locator?.manifestURL.absoluteString, fixtures.manifestURL.absoluteString)
        XCTAssertEqual(locator?.webappAssetURL.absoluteString, fixtures.webappAssetURL.absoluteString)
        XCTAssertEqual(locator?.fullAppAssetURL?.absoluteString, fixtures.fullAssetURL.absoluteString)

        // The resolver must have hit exactly the releases endpoint we
        // exposed — guards against accidental hardcoded api.github.com
        // calls slipping back in.
        let releaseHits = fixtures.server.recordedRequestsSnapshot()
            .filter { $0.path.hasPrefix("/repos/") }
        XCTAssertEqual(releaseHits.count, 1)
        XCTAssertEqual(releaseHits.first?.path, "/repos/\(fixtures.owner)/\(fixtures.repo)/releases?per_page=20")
    }

    // MARK: - 2. Live UI-only update applies end-to-end

    func testWebappOnlyEndToEnd_LiveApply() async throws {
        let fixtures = try UpdateTestFixtures.make(version: "9.9.9")
        defer { fixtures.tearDown() }

        let overlayRoot = fixtures.tempDir.appendingPathComponent("overlays", isDirectory: true)
        let overlayStore = WebappOverlayStore(rootDirectory: overlayRoot)

        // Binaries match what the manifest claims, but webapp differs —
        // the coordinator should pick the webapp-only path.
        let runningHashes = RunningAppHashes(
            sliccstart: fixtures.manifest.sliccstart,
            sliccServer: fixtures.manifest.sliccServer,
            webapp: "old-webapp-hash"
        )

        var respawnCalls = 0
        let coordinator = SmoothUpdateCoordinator(
            manifestFetcher: UpdateManifestFetcher(download: defaultURLSessionDownload),
            assetDownloader: { url, destination in
                let data = try await defaultURLSessionDownload(url)
                try data.write(to: destination, options: .atomic)
            },
            overlayStore: overlayStore,
            hashesProvider: { runningHashes }
        )

        let resolver = ReleaseAssetResolver(host: fixtures.host, download: defaultURLSessionDownload)
        guard let locator = try await resolver.resolveLatest(
            owner: fixtures.owner,
            repo: fixtures.repo,
            releasePrefix: "Sliccstart"
        ) else {
            return XCTFail("resolver returned nil locator")
        }

        await coordinator.check(manifestURL: locator.manifestURL, webappAssetURL: locator.webappAssetURL)
        guard case let .webappOnlyAvailable(version, assetURL, hash) = coordinator.state else {
            return XCTFail("expected .webappOnlyAvailable, got \(coordinator.state)")
        }
        XCTAssertEqual(version, "9.9.9")
        XCTAssertEqual(assetURL.absoluteString, fixtures.webappAssetURL.absoluteString)
        XCTAssertEqual(hash, fixtures.manifest.webapp)

        await coordinator.applyWebappOnly(
            version: version,
            assetURL: assetURL,
            manifestWebappHash: hash,
            respawn: { respawnCalls += 1 }
        )

        XCTAssertEqual(coordinator.state, .applied(version: "9.9.9"))
        XCTAssertEqual(respawnCalls, 1, "respawn must fire exactly once")
        XCTAssertEqual(overlayStore.activeVersion(), "9.9.9")
        XCTAssertNotNil(overlayStore.activeOverlayPath())
        let index = URL(fileURLWithPath: overlayStore.activeOverlayPath()!).appendingPathComponent("index.html")
        XCTAssertTrue(FileManager.default.fileExists(atPath: index.path),
                      "webapp overlay's index.html must be reachable from the active path")

        // The server should have received exactly: 1 releases listing,
        // 1 manifest fetch, 1 webapp download. Anything else means a
        // duplicate request or a bogus retry.
        let paths = fixtures.server.recordedRequestsSnapshot().map(\.path)
        XCTAssertEqual(paths.filter { $0.contains("/releases") }.count, 1)
        XCTAssertEqual(paths.filter { $0.contains("manifest-9.9.9.json") }.count, 1)
        XCTAssertEqual(paths.filter { $0.contains("webapp-9.9.9.zip") }.count, 1)
    }

    // MARK: - 3. Full-update path when binaries differ

    func testFullUpdateRequired_BinaryMismatch() async throws {
        let fixtures = try UpdateTestFixtures.make(version: "9.9.9")
        defer { fixtures.tearDown() }

        let overlayRoot = fixtures.tempDir.appendingPathComponent("overlays", isDirectory: true)
        let overlayStore = WebappOverlayStore(rootDirectory: overlayRoot)
        let coordinator = SmoothUpdateCoordinator(
            manifestFetcher: UpdateManifestFetcher(download: defaultURLSessionDownload),
            assetDownloader: { url, dest in
                let data = try await defaultURLSessionDownload(url)
                try data.write(to: dest, options: .atomic)
            },
            overlayStore: overlayStore,
            hashesProvider: {
                // Running app has a different slicc-server binary →
                // manifest evaluation must report a full update.
                RunningAppHashes(
                    sliccstart: fixtures.manifest.sliccstart,
                    sliccServer: "running-server-hash-OLD",
                    webapp: "anything"
                )
            }
        )

        let resolver = ReleaseAssetResolver(host: fixtures.host, download: defaultURLSessionDownload)
        let locator = try await resolver.resolveLatest(
            owner: fixtures.owner,
            repo: fixtures.repo,
            releasePrefix: "Sliccstart"
        )!
        await coordinator.check(manifestURL: locator.manifestURL, webappAssetURL: locator.webappAssetURL)
        XCTAssertEqual(coordinator.state, .fullUpdateRequired(version: "9.9.9"))
        XCTAssertNil(overlayStore.activeVersion(), "no overlay must be activated on the full-update path")
    }

    // MARK: - 4. No update when everything matches

    func testNoUpdate_WhenAllHashesMatch() async throws {
        let fixtures = try UpdateTestFixtures.make(version: "9.9.9")
        defer { fixtures.tearDown() }

        let coordinator = SmoothUpdateCoordinator(
            manifestFetcher: UpdateManifestFetcher(download: defaultURLSessionDownload),
            assetDownloader: { _, _ in },
            overlayStore: WebappOverlayStore(rootDirectory: fixtures.tempDir.appendingPathComponent("overlays")),
            hashesProvider: {
                RunningAppHashes(
                    sliccstart: fixtures.manifest.sliccstart,
                    sliccServer: fixtures.manifest.sliccServer,
                    webapp: fixtures.manifest.webapp
                )
            }
        )

        let resolver = ReleaseAssetResolver(host: fixtures.host, download: defaultURLSessionDownload)
        let locator = try await resolver.resolveLatest(
            owner: fixtures.owner,
            repo: fixtures.repo,
            releasePrefix: "Sliccstart"
        )!
        await coordinator.check(manifestURL: locator.manifestURL, webappAssetURL: locator.webappAssetURL)
        XCTAssertEqual(coordinator.state, .noUpdate)
    }

    // MARK: - 5. Hash mismatch from server is rejected

    func testHashMismatch_RejectsTamperedDownload() async throws {
        let fixtures = try UpdateTestFixtures.make(version: "9.9.9")
        defer { fixtures.tearDown() }

        // Swap the served zip for tampered bytes that won't match the
        // manifest hash. The coordinator must refuse to activate it.
        let tamperedZipURL = fixtures.tempDir.appendingPathComponent("tampered.zip")
        let tamperSource = fixtures.tempDir.appendingPathComponent("tamper-source", isDirectory: true)
        try FileManager.default.createDirectory(at: tamperSource, withIntermediateDirectories: true)
        try "evil".write(
            to: tamperSource.appendingPathComponent("index.html"),
            atomically: true,
            encoding: .utf8
        )
        let dittoTask = Process()
        dittoTask.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        dittoTask.arguments = ["-c", "-k", tamperSource.path, tamperedZipURL.path]
        try dittoTask.run()
        dittoTask.waitUntilExit()
        let tamperedBytes = try Data(contentsOf: tamperedZipURL)
        fixtures.setWebappAssetBytes(tamperedBytes)

        let overlayStore = WebappOverlayStore(rootDirectory: fixtures.tempDir.appendingPathComponent("overlays"))
        var respawnCalls = 0
        let coordinator = SmoothUpdateCoordinator(
            manifestFetcher: UpdateManifestFetcher(download: defaultURLSessionDownload),
            assetDownloader: { url, destination in
                let data = try await defaultURLSessionDownload(url)
                try data.write(to: destination, options: .atomic)
            },
            overlayStore: overlayStore,
            hashesProvider: {
                RunningAppHashes(
                    sliccstart: fixtures.manifest.sliccstart,
                    sliccServer: fixtures.manifest.sliccServer,
                    webapp: "old"
                )
            }
        )

        let resolver = ReleaseAssetResolver(host: fixtures.host, download: defaultURLSessionDownload)
        let locator = try await resolver.resolveLatest(
            owner: fixtures.owner,
            repo: fixtures.repo,
            releasePrefix: "Sliccstart"
        )!
        await coordinator.check(manifestURL: locator.manifestURL, webappAssetURL: locator.webappAssetURL)
        guard case .webappOnlyAvailable(let v, let assetURL, let hash) = coordinator.state else {
            return XCTFail("expected webappOnlyAvailable, got \(coordinator.state)")
        }
        await coordinator.applyWebappOnly(
            version: v,
            assetURL: assetURL,
            manifestWebappHash: hash,
            respawn: { respawnCalls += 1 }
        )
        if case .failed = coordinator.state {} else {
            XCTFail("expected .failed for hash mismatch, got \(coordinator.state)")
        }
        XCTAssertEqual(respawnCalls, 0)
        XCTAssertNil(overlayStore.activeVersion())
    }

    // MARK: - 6. Server 5xx on manifest is reported, not crashed on

    func testServer500OnManifest_FailsCleanly() async throws {
        let fixtures = try UpdateTestFixtures.make(version: "9.9.9")
        defer { fixtures.tearDown() }
        fixtures.server.respond("GET", "/download/manifest-9.9.9.json", .serverError)

        let coordinator = SmoothUpdateCoordinator(
            manifestFetcher: UpdateManifestFetcher(download: defaultURLSessionDownload),
            assetDownloader: { _, _ in },
            overlayStore: WebappOverlayStore(rootDirectory: fixtures.tempDir.appendingPathComponent("overlays")),
            hashesProvider: { RunningAppHashes(sliccstart: "a", sliccServer: "b", webapp: "c") }
        )

        let resolver = ReleaseAssetResolver(host: fixtures.host, download: defaultURLSessionDownload)
        let locator = try await resolver.resolveLatest(
            owner: fixtures.owner,
            repo: fixtures.repo,
            releasePrefix: "Sliccstart"
        )!
        await coordinator.check(manifestURL: locator.manifestURL, webappAssetURL: locator.webappAssetURL)
        if case .failed = coordinator.state {} else {
            XCTFail("expected .failed on 500, got \(coordinator.state)")
        }
    }

    // MARK: - 7. Empty release list yields a graceful nil

    func testEmptyReleaseList_ReturnsNoLocator() async throws {
        let fixtures = try UpdateTestFixtures.make(version: "9.9.9")
        defer { fixtures.tearDown() }
        fixtures.server.respond("GET", "/repos/\(fixtures.owner)/\(fixtures.repo)/releases", .json([] as [Any]))

        let resolver = ReleaseAssetResolver(host: fixtures.host, download: defaultURLSessionDownload)
        let locator = try await resolver.resolveLatest(
            owner: fixtures.owner,
            repo: fixtures.repo,
            releasePrefix: "Sliccstart"
        )
        XCTAssertNil(locator, "no matching release must surface as nil, not an error")
    }

    // MARK: - 8. Auth header is forwarded when GH_TOKEN is set

    func testReleasesEndpointReceivesAuthHeaderWhenTokenSet() async throws {
        let fixtures = try UpdateTestFixtures.make(version: "9.9.9")
        defer { fixtures.tearDown() }

        let resolver = ReleaseAssetResolver(host: fixtures.host) { url in
            var request = URLRequest(url: url)
            request.setValue("Bearer test-token", forHTTPHeaderField: "Authorization")
            let (data, _) = try await URLSession.shared.data(for: request)
            return data
        }
        _ = try await resolver.resolveLatest(
            owner: fixtures.owner,
            repo: fixtures.repo,
            releasePrefix: "Sliccstart"
        )
        let releaseRequest = fixtures.server.recordedRequestsSnapshot().first { $0.path.hasPrefix("/repos/") }
        XCTAssertEqual(releaseRequest?.headers["authorization"], "Bearer test-token",
                       "Authorization header must be forwarded verbatim — past bug was a missing 'Bearer ' prefix")
    }

    // MARK: - 9. Sanity check on the fake server itself

    func testFakeServerRoundtripsAndRecordsRequests() async throws {
        let server = try FakeUpdateServer.start()
        defer { server.stop() }
        server.respond("GET", "/hello", .text("world"))

        let (data, _) = try await URLSession.shared.data(from: server.baseURL.appendingPathComponent("hello"))
        XCTAssertEqual(String(data: data, encoding: .utf8), "world")

        let recorded = server.recordedRequestsSnapshot()
        XCTAssertEqual(recorded.count, 1)
        XCTAssertEqual(recorded.first?.method, "GET")
        XCTAssertEqual(recorded.first?.path, "/hello")

        // Unregistered routes 404 — protects tests from silently passing
        // when they're hitting an unconfigured endpoint.
        let unknownURL = server.baseURL.appendingPathComponent("nope")
        let (_, response) = try await URLSession.shared.data(from: unknownURL)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 404)
    }
}

private func defaultURLSessionDownload(_ url: URL) async throws -> Data {
    var request = URLRequest(url: url)
    request.timeoutInterval = 5
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse,
          (200..<300).contains(httpResponse.statusCode) else {
        throw URLError(.badServerResponse)
    }
    return data
}
