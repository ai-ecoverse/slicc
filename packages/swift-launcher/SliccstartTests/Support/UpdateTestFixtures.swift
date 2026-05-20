import Foundation
@testable import Sliccstart

/// Builds a self-contained "release" on disk and configures a
/// `FakeUpdateServer` to serve it. Keeps every test independent: each
/// invocation lives in its own temp directory and only registers routes
/// for one release.
struct UpdateTestFixtures {
    let tempDir: URL
    let server: FakeUpdateServer
    let version: String
    let owner: String
    let repo: String

    /// sha256s of the bytes the server is shipping. These match what
    /// Sliccstart would compute against the unpacked webapp/binaries.
    let manifest: UpdateManifest

    /// In-memory bytes the server returns for the webapp zip. Tests can
    /// override these to simulate tampered downloads.
    let webappZipURL: URL

    static func make(
        version: String = "9.9.9",
        owner: String = "ai-ecoverse",
        repo: String = "slicc",
        webappContents: [String: String] = ["index.html": "<html>fixture</html>"],
        binariesSliccstartHash: String = "running-sliccstart-hash",
        binariesServerHash: String = "running-server-hash"
    ) throws -> UpdateTestFixtures {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("UpdateTestFixtures-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

        // Build the unpacked webapp tree, compute its hash, then ditto it
        // into a zip so the test can download the *real bytes* over HTTP.
        let webappStaging = tempDir.appendingPathComponent("webapp-source", isDirectory: true)
        try FileManager.default.createDirectory(at: webappStaging, withIntermediateDirectories: true)
        for (name, content) in webappContents {
            let target = webappStaging.appendingPathComponent(name)
            if name.contains("/") {
                let parent = target.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            }
            try content.write(to: target, atomically: true, encoding: .utf8)
        }
        let webappHash = try sha256Directory(at: webappStaging)
        let webappZip = tempDir.appendingPathComponent("webapp-\(version).zip")
        try dittoZip(contentsOf: webappStaging, to: webappZip)

        let manifest = UpdateManifest(
            version: version,
            sliccstart: binariesSliccstartHash,
            sliccServer: binariesServerHash,
            webapp: webappHash,
            webappAsset: "webapp-\(version).zip"
        )

        let server = try FakeUpdateServer.start()
        let fixtures = UpdateTestFixtures(
            tempDir: tempDir,
            server: server,
            version: version,
            owner: owner,
            repo: repo,
            manifest: manifest,
            webappZipURL: webappZip
        )
        fixtures.registerRoutes()
        return fixtures
    }

    func tearDown() {
        server.stop()
        try? FileManager.default.removeItem(at: tempDir)
    }

    /// URL the manifest is reachable at via the fake server.
    var manifestURL: URL {
        server.baseURL.appendingPathComponent("download/manifest-\(version).json")
    }

    /// URL the webapp zip is reachable at via the fake server.
    var webappAssetURL: URL {
        server.baseURL.appendingPathComponent("download/webapp-\(version).zip")
    }

    /// URL the full Sliccstart zip is reachable at via the fake server
    /// (the bytes are empty — exercised only by the resolver, not by
    /// AppUpdater itself in these tests).
    var fullAssetURL: URL {
        server.baseURL.appendingPathComponent("download/Sliccstart-\(version).zip")
    }

    /// A pre-configured host pointing at the fake server.
    var host: UpdateHostConfiguration {
        UpdateHostConfiguration(baseURL: server.baseURL)
    }

    /// Replace the manifest payload returned by the server. Useful for
    /// tests that need to flip server-side hashes without rebuilding the
    /// whole fixture.
    func setManifestOnServer(_ manifest: UpdateManifest) {
        let payload: [String: Any] = [
            "version": manifest.version,
            "sliccstart": manifest.sliccstart,
            "sliccServer": manifest.sliccServer,
            "webapp": manifest.webapp,
            "webappAsset": manifest.webappAsset,
        ]
        server.respond("GET", "/download/manifest-\(manifest.version).json", .json(payload))
    }

    /// Replace the bytes returned for the webapp asset. Used by the
    /// "tampered download" test.
    func setWebappAssetBytes(_ data: Data) {
        server.respond("GET", "/download/webapp-\(version).zip", .bytes(data, contentType: "application/zip"))
    }

    private func registerRoutes() {
        // Releases listing — minimal shape consumed by both
        // `ReleaseAssetResolver` and (transitively) `AppUpdater`.
        let releasesPayload: [[String: Any]] = [[
            "tag_name": "Sliccstart-\(version)",
            "name": "Sliccstart-\(version)",
            "assets": [
                [
                    "name": "manifest-\(version).json",
                    "browser_download_url": manifestURL.absoluteString,
                ],
                [
                    "name": "webapp-\(version).zip",
                    "browser_download_url": webappAssetURL.absoluteString,
                ],
                [
                    "name": "Sliccstart-\(version).zip",
                    "browser_download_url": fullAssetURL.absoluteString,
                ],
            ],
        ]]
        server.respond("GET", "/repos/\(owner)/\(repo)/releases", .json(releasesPayload))

        // Manifest asset.
        setManifestOnServer(manifest)

        // Webapp asset — serve the real ditto zip bytes.
        let webappBytes = (try? Data(contentsOf: webappZipURL)) ?? Data()
        server.respond("GET", "/download/webapp-\(version).zip", .bytes(webappBytes, contentType: "application/zip"))

        // Stub for the full app asset; tests can override with real bytes.
        server.respond("GET", "/download/Sliccstart-\(version).zip", .bytes(Data(), contentType: "application/zip"))
    }
}

private func dittoZip(contentsOf sourceDir: URL, to destinationZip: URL) throws {
    if FileManager.default.fileExists(atPath: destinationZip.path) {
        try FileManager.default.removeItem(at: destinationZip)
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    task.arguments = ["-c", "-k", sourceDir.path, destinationZip.path]
    try task.run()
    task.waitUntilExit()
    if task.terminationStatus != 0 {
        throw NSError(domain: "UpdateTestFixtures", code: Int(task.terminationStatus), userInfo: [
            NSLocalizedDescriptionKey: "ditto failed",
        ])
    }
}
