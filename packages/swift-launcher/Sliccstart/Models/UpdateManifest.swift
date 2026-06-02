import Foundation
import CryptoKit
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "UpdateManifest")

/// Per-release manifest published next to the .app .zip. Lets Sliccstart
/// decide whether an available update only changed the webapp (`dist/ui`)
/// or also touched the Swift binaries. When only the webapp changed we
/// download a tiny `webapp-<version>.zip` and hot-swap the UI without
/// relaunching Sliccstart.
struct UpdateManifest: Codable, Equatable {
    let version: String
    /// sha256 of the `Sliccstart` Mach-O binary.
    let sliccstart: String
    /// sha256 of the `slicc-server` Mach-O binary.
    let sliccServer: String
    /// sha256 of the deterministically-tarred `dist/ui` directory.
    let webapp: String
    /// Asset name for the UI-only zip. Filename relative to the GitHub
    /// release; we don't store the absolute URL because the release
    /// page already gives us the asset list.
    let webappAsset: String

    /// Compare a manifest against the currently-running .app to decide
    /// which update path to take.
    enum UpdateKind: Equatable {
        case noChange
        case webappOnly
        case fullApp
    }

    func compare(toRunningHashes hashes: RunningAppHashes) -> UpdateKind {
        let binariesMatch =
            hashes.sliccstart == sliccstart &&
            hashes.sliccServer == sliccServer
        if !binariesMatch {
            return .fullApp
        }
        if hashes.webapp == webapp {
            return .noChange
        }
        return .webappOnly
    }
}

/// SHA-256 hashes of the binaries shipped inside the currently-running
/// Sliccstart.app bundle. Computed once at update-check time.
struct RunningAppHashes: Equatable {
    let sliccstart: String
    let sliccServer: String
    let webapp: String

    static func compute(bundle: Bundle = .main, fileManager: FileManager = .default) throws -> RunningAppHashes {
        guard let resourcePath = bundle.resourcePath else {
            throw UpdateManifestError.bundleResourcePathMissing
        }
        let macOSDir = bundle.bundleURL.appendingPathComponent("Contents/MacOS")
        let sliccstartBinary = macOSDir.appendingPathComponent("Sliccstart")
        let serverBinary = URL(fileURLWithPath: resourcePath).appendingPathComponent("slicc-server")
        let uiDir = URL(fileURLWithPath: resourcePath)
            .appendingPathComponent("slicc/dist/ui", isDirectory: true)

        return RunningAppHashes(
            sliccstart: try sha256File(at: sliccstartBinary, fileManager: fileManager),
            sliccServer: try sha256File(at: serverBinary, fileManager: fileManager),
            webapp: try sha256Directory(at: uiDir, fileManager: fileManager)
        )
    }
}

enum UpdateManifestError: LocalizedError {
    case bundleResourcePathMissing
    case fileMissing(URL)

    var errorDescription: String? {
        switch self {
        case .bundleResourcePathMissing:
            return "Bundle.resourcePath is missing — cannot compute update hashes."
        case .fileMissing(let url):
            return "Required file for hashing is missing: \(url.path)"
        }
    }
}

/// SHA-256 of a single file's bytes. Streams in 1MB chunks so we don't load
/// large binaries fully into memory.
func sha256File(at url: URL, fileManager: FileManager = .default) throws -> String {
    guard fileManager.fileExists(atPath: url.path) else {
        throw UpdateManifestError.fileMissing(url)
    }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    let chunkSize = 1 << 20
    while true {
        let chunk = handle.readData(ofLength: chunkSize)
        if chunk.isEmpty { break }
        hasher.update(data: chunk)
    }
    let digest = hasher.finalize()
    return digest.map { String(format: "%02x", $0) }.joined()
}

/// Deterministic SHA-256 of a directory tree: sort relative paths, hash
/// each "path:<sha256>" line. Matches the script in
/// `sign-and-package.sh` so the manifest published with each release
/// agrees with what Sliccstart computes locally.
func sha256Directory(at directoryURL: URL, fileManager: FileManager = .default) throws -> String {
    guard fileManager.fileExists(atPath: directoryURL.path) else {
        throw UpdateManifestError.fileMissing(directoryURL)
    }
    let basePath = directoryURL.standardizedFileURL.path
    var entries: [String] = []
    guard let enumerator = fileManager.enumerator(
        at: directoryURL,
        includingPropertiesForKeys: [.isRegularFileKey],
        options: [.skipsHiddenFiles]
    ) else {
        throw UpdateManifestError.fileMissing(directoryURL)
    }
    for case let fileURL as URL in enumerator {
        let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey])
        guard values.isRegularFile == true else { continue }
        let absolute = fileURL.standardizedFileURL.path
        guard absolute.hasPrefix(basePath) else { continue }
        var rel = String(absolute.dropFirst(basePath.count))
        if rel.hasPrefix("/") { rel.removeFirst() }
        let fileHash = try sha256File(at: fileURL, fileManager: fileManager)
        entries.append("\(rel):\(fileHash)")
    }
    entries.sort()
    let combined = entries.joined(separator: "\n")
    let digest = SHA256.hash(data: Data(combined.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

/// Resolved download URLs for the manifest and the webapp-only asset of a
/// GitHub release. Looked up via the API so the launcher works against
/// whatever asset names the publishing pipeline produces.
struct ReleaseAssetLocator: Equatable {
    let version: String
    let manifestURL: URL
    let webappAssetURL: URL
    let fullAppAssetURL: URL?
}

/// Walks the GitHub release listing to find the latest release whose tag
/// matches the Sliccstart prefix and returns the URLs for its manifest
/// and webapp-only asset. The full Sliccstart zip URL is returned too so
/// the caller can pass it through to AppUpdater when a full upgrade is
/// required.
struct ReleaseAssetResolver {
    let download: (URL) async throws -> Data
    let host: UpdateHostConfiguration

    static let `default` = ReleaseAssetResolver(
        host: UpdateHostConfiguration.resolve(),
        download: { url in
            var request = URLRequest(url: url)
            request.timeoutInterval = 10
            if let token = ProcessInfo.processInfo.environment["GH_TOKEN"], !token.isEmpty {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }
            return data
        }
    )

    init(
        host: UpdateHostConfiguration = UpdateHostConfiguration.resolve(),
        download: @escaping (URL) async throws -> Data
    ) {
        self.host = host
        self.download = download
    }

    func resolveLatest(
        owner: String,
        repo: String,
        releasePrefix: String
    ) async throws -> ReleaseAssetLocator? {
        var components = URLComponents(url: host.releasesURL(owner: owner, repo: repo), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "per_page", value: "20")]
        let url = components.url!
        let data = try await download(url)
        let decoder = JSONDecoder()
        let releases = try decoder.decode([ReleaseRecord].self, from: data)
        let matching = releases
            .filter { $0.tagName.hasPrefix(releasePrefix) || $0.name?.hasPrefix(releasePrefix) == true }
            .first
        guard let release = matching else { return nil }
        let version = release.tagName
            .replacingOccurrences(of: releasePrefix, with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "-v "))
        let manifestAsset = release.assets.first { $0.name == "manifest-\(version).json" }
        let webappAsset = release.assets.first { $0.name == "webapp-\(version).zip" }
        let fullAsset = release.assets.first { $0.name.hasPrefix("Sliccstart-") && $0.name.hasSuffix(".zip") }
        guard let manifest = manifestAsset, let webapp = webappAsset else { return nil }
        return ReleaseAssetLocator(
            version: version,
            manifestURL: URL(string: manifest.browserDownloadURL)!,
            webappAssetURL: URL(string: webapp.browserDownloadURL)!,
            fullAppAssetURL: fullAsset.flatMap { URL(string: $0.browserDownloadURL) }
        )
    }

    private struct ReleaseRecord: Decodable {
        let tagName: String
        let name: String?
        let assets: [AssetRecord]

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case name
            case assets
        }
    }

    private struct AssetRecord: Decodable {
        let name: String
        let browserDownloadURL: String

        enum CodingKeys: String, CodingKey {
            case name
            case browserDownloadURL = "browser_download_url"
        }
    }
}

/// Fetcher for the manifest asset of a given release. Decoupled from
/// `URLSession` for testability and to make the AppUpdater hand-off
/// trivial later (we already have a release listing in
/// `TolerantGithubReleaseProvider`).
struct UpdateManifestFetcher {
    let download: (URL) async throws -> Data

    static let `default` = UpdateManifestFetcher(download: { url in
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return data
    })

    func fetch(from url: URL) async throws -> UpdateManifest {
        let data = try await download(url)
        return try JSONDecoder().decode(UpdateManifest.self, from: data)
    }
}
