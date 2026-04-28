import XCTest
@testable import Sliccstart

final class WebKitInstallerTests: XCTestCase {
    func testCurrentPlatformKeyAppleSilicon() {
        let key = WebKitInstaller.currentPlatformKey(
            osVersion: OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            machine: "arm64"
        )
        XCTAssertEqual(key, "mac15-arm64")
    }

    func testCurrentPlatformKeyIntel() {
        let key = WebKitInstaller.currentPlatformKey(
            osVersion: OperatingSystemVersion(majorVersion: 14, minorVersion: 5, patchVersion: 0),
            machine: "x86_64"
        )
        XCTAssertEqual(key, "mac14")
    }

    func testResolvePlatformKeyReturnsExactMatch() {
        let key = WebKitInstaller.resolvePlatformKey(
            available: ["mac14", "mac14-arm64", "mac15", "mac15-arm64"],
            osVersion: OperatingSystemVersion(majorVersion: 15, minorVersion: 1, patchVersion: 0),
            machine: "arm64"
        )
        XCTAssertEqual(key, "mac15-arm64")
    }

    func testResolvePlatformKeyForwardCompatNewerHost() {
        // Host is macOS 26 (Apple's version-numbering jump). Manifest stops
        // at mac15 — Apple binary compat means mac15-arm64 runs on mac26.
        let key = WebKitInstaller.resolvePlatformKey(
            available: ["mac14", "mac14-arm64", "mac15", "mac15-arm64"],
            osVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0),
            machine: "arm64"
        )
        XCTAssertEqual(key, "mac15-arm64")
    }

    func testResolvePlatformKeyOlderHost() {
        // Host is macOS 13 but manifest only has mac14/mac15 — pick highest
        // available rather than failing, matching Playwright behaviour.
        let key = WebKitInstaller.resolvePlatformKey(
            available: ["mac14", "mac14-arm64", "mac15", "mac15-arm64"],
            osVersion: OperatingSystemVersion(majorVersion: 13, minorVersion: 0, patchVersion: 0),
            machine: "arm64"
        )
        XCTAssertEqual(key, "mac15-arm64")
    }

    func testResolvePlatformKeyFallsBackToHighestLEQHost() {
        let key = WebKitInstaller.resolvePlatformKey(
            available: ["mac11-arm64", "mac13-arm64", "mac15-arm64"],
            osVersion: OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 0),
            machine: "arm64"
        )
        XCTAssertEqual(key, "mac13-arm64")
    }

    func testResolvePlatformKeyRespectsArch() {
        // Intel host should not get arm64 builds even if those are the only
        // ones near the host's mac major.
        let key = WebKitInstaller.resolvePlatformKey(
            available: ["mac14-arm64", "mac15-arm64", "mac11"],
            osVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0),
            machine: "x86_64"
        )
        XCTAssertEqual(key, "mac11")
    }

    func testResolvePlatformKeyReturnsNilWhenArchMissing() {
        // Intel host with arm64-only manifest — nothing fits.
        let key = WebKitInstaller.resolvePlatformKey(
            available: ["mac14-arm64", "mac15-arm64"],
            osVersion: OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0),
            machine: "x86_64"
        )
        XCTAssertNil(key)
    }

    func testManifestContainsCurrentMacosPlatforms() {
        // Sliccstart targets macOS 14+. We don't ship to older macOS, so we
        // only need mac14 / mac15 keys to exist. If Renovate bumps the
        // playwright-core dep and Apple has dropped one of these majors,
        // this test will fail-loud rather than silently breaking installs.
        let keys = WebKitManifest.downloadUrlsByPlatform.keys
        XCTAssertTrue(keys.contains("mac14"), "mac14 missing from generated manifest")
        XCTAssertTrue(keys.contains("mac14-arm64"), "mac14-arm64 missing from generated manifest")
        XCTAssertTrue(keys.contains("mac15"), "mac15 missing from generated manifest")
        XCTAssertTrue(keys.contains("mac15-arm64"), "mac15-arm64 missing from generated manifest")
    }

    func testFormatBytesScalesUnits() {
        XCTAssertEqual(WebKitInstaller.formatBytes(0), "0 B")
        XCTAssertEqual(WebKitInstaller.formatBytes(512), "512 B")
        XCTAssertEqual(WebKitInstaller.formatBytes(2 * 1024), "2.0 KB")
        XCTAssertEqual(WebKitInstaller.formatBytes(5 * 1024 * 1024), "5.0 MB")
        XCTAssertEqual(WebKitInstaller.formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB")
    }

    func testFormatDurationRanges() {
        XCTAssertEqual(WebKitInstaller.formatDuration(5), "5s")
        XCTAssertEqual(WebKitInstaller.formatDuration(59.4), "59s")
        XCTAssertEqual(WebKitInstaller.formatDuration(60), "1m")
        XCTAssertEqual(WebKitInstaller.formatDuration(83), "1m 23s")
        XCTAssertEqual(WebKitInstaller.formatDuration(3600), "1h")
        XCTAssertEqual(WebKitInstaller.formatDuration(3725), "1h 2m")
    }

    func testFormatDownloadProgressWithKnownTotal() {
        let result = WebKitInstaller.formatDownloadProgress(
            bytesDone: 10 * 1024 * 1024,
            totalBytes: 100 * 1024 * 1024,
            elapsed: 5.0
        )
        XCTAssertTrue(result.contains("10%"), result)
        XCTAssertTrue(result.contains("10.0 MB/100.0 MB"), result)
        XCTAssertTrue(result.contains("/s"), result)
        // 90 MB at 2 MB/s = 45s
        XCTAssertTrue(result.contains("s") && !result.contains("0s"), result)
    }

    func testFormatDownloadProgressWithUnknownTotal() {
        // Server didn't send Content-Length — totalBytes == -1 from the
        // URLSession callback. We should still emit a useful message.
        let result = WebKitInstaller.formatDownloadProgress(
            bytesDone: 5 * 1024 * 1024,
            totalBytes: -1,
            elapsed: 2.0
        )
        XCTAssertTrue(result.contains("5.0 MB"), result)
        XCTAssertFalse(result.contains("%"), result) // no percent
    }

    func testFormatDownloadProgressBeforeFirstChunk() {
        let result = WebKitInstaller.formatDownloadProgress(
            bytesDone: 0,
            totalBytes: 1_000_000,
            elapsed: 0.1
        )
        XCTAssertEqual(result, "Starting download...")
    }

    func testManifestUrlsAreHttps() {
        for (platform, urls) in WebKitManifest.downloadUrlsByPlatform {
            XCTAssertFalse(urls.isEmpty, "no URLs for \(platform)")
            for urlString in urls {
                XCTAssertTrue(
                    urlString.hasPrefix("https://"),
                    "WebKit download URL is not HTTPS: \(urlString)"
                )
                XCTAssertNotNil(URL(string: urlString), "invalid URL: \(urlString)")
                XCTAssertTrue(
                    urlString.contains("/builds/webkit/\(WebKitManifest.revision)/"),
                    "URL does not embed the manifest revision: \(urlString)"
                )
            }
        }
    }

    func testInstallArchiveUsesFirstSuccessfulMirror() async throws {
        let fm = FileManager.default
        let tempRoot = NSTemporaryDirectory() + "wkinstaller-\(UUID().uuidString)"
        defer { try? fm.removeItem(atPath: tempRoot) }
        try fm.createDirectory(atPath: tempRoot, withIntermediateDirectories: true)

        let downloader = RecordingDownloader(failingPrefixes: ["https://broken.example/"])
        let extractor = StubExtractor { destinationDir in
            // Pretend the archive contained a Playwright.app
            let app = "\(destinationDir)/Playwright.app/Contents/MacOS"
            try fm.createDirectory(atPath: app, withIntermediateDirectories: true)
            fm.createFile(atPath: "\(app)/Playwright", contents: Data())
        }

        let installDir = "\(tempRoot)/webkit-test"
        try await WebKitInstaller.installArchive(
            urls: [
                "https://broken.example/a.zip",
                "https://ok.example/a.zip",
                "https://other.example/a.zip",
            ],
            cacheDir: tempRoot,
            installDir: installDir,
            progress: { _ in },
            downloader: downloader,
            extractor: extractor
        )

        let attempts = await downloader.attempts
        XCTAssertEqual(attempts, [
            "https://broken.example/a.zip",
            "https://ok.example/a.zip",
        ])
        XCTAssertTrue(fm.fileExists(atPath: "\(installDir)/Playwright.app/Contents/MacOS/Playwright"))
    }

    func testInstallArchiveThrowsWhenAllMirrorsFail() async throws {
        let fm = FileManager.default
        let tempRoot = NSTemporaryDirectory() + "wkinstaller-\(UUID().uuidString)"
        defer { try? fm.removeItem(atPath: tempRoot) }
        try fm.createDirectory(atPath: tempRoot, withIntermediateDirectories: true)

        let downloader = RecordingDownloader(failingPrefixes: ["https://"])
        let extractor = StubExtractor { _ in
            XCTFail("extractor should not be called when all downloads fail")
        }

        do {
            try await WebKitInstaller.installArchive(
                urls: ["https://a/", "https://b/"],
                cacheDir: tempRoot,
                installDir: "\(tempRoot)/never",
                progress: { _ in },
                downloader: downloader,
                extractor: extractor
            )
            XCTFail("expected error")
        } catch {
            // expected
        }

        let attempts = await downloader.attempts
        XCTAssertEqual(attempts.count, 2, "all mirrors should have been attempted")
        XCTAssertFalse(fm.fileExists(atPath: "\(tempRoot)/never"))
    }
}

private actor RecordingDownloader: WebKitDownloader {
    private(set) var attempts: [String] = []
    private let failingPrefixes: [String]

    init(failingPrefixes: [String]) {
        self.failingPrefixes = failingPrefixes
    }

    nonisolated func download(
        from url: String,
        to path: String,
        progress: @escaping @Sendable (String) -> Void
    ) async throws {
        await record(url: url)
        if failingPrefixes.contains(where: { url.hasPrefix($0) }) {
            throw WebKitManager.WebKitError.downloadFailed(url: url, status: 500, underlying: "stub")
        }
        // Pretend we wrote a zip to `path`.
        FileManager.default.createFile(atPath: path, contents: Data([0x50, 0x4B, 0x03, 0x04]))
        progress("ok")
    }

    private func record(url: String) {
        attempts.append(url)
    }
}

private struct StubExtractor: WebKitExtractor {
    let onExtract: @Sendable (_ destinationDir: String) throws -> Void

    func extract(archivePath: String, destinationDir: String) throws {
        try onExtract(destinationDir)
    }
}
