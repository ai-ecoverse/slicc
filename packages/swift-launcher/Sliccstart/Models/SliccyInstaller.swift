import AppKit
import CryptoKit
import Darwin
import Foundation

/// A reviewed, compatible release, independent of both apps' updater feeds.
enum SliccyRelease {
    static let version = "7.3.0"
    static let minimumOSMajor = 26
    static let notesURL = URL(string: "https://github.com/ai-ecoverse/sliccy-app/releases/tag/v\(version)")!
    static let downloadURL = URL(string: "https://github.com/ai-ecoverse/sliccy-app/releases/download/v7.3.0/Sliccy-7.3.0.dmg")!
    static let sha256 = "6ca28a51454a1d7ca63c99538775d4a2f4a948c241e1f8972825dd4ae390f12a"
    static let signingRequirement =
        "=anchor apple generic and identifier \"ai.sliccy.mac\" "
        + "and certificate leaf[field.1.2.840.113635.100.6.1.13] exists "
        + "and certificate leaf[subject.OU] = \"S8LB56P782\""
}

enum SliccyInstallError: LocalizedError {
    case unsupportedMac
    case alreadyInstalled(URL)
    case invalidDownload
    case invalidBundle
    case commandFailed(String)
    case commandTimedOut(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedMac:
            "Sliccy requires macOS 26 or newer and Apple silicon."
        case .alreadyInstalled(let url):
            "An app already exists at \(url.path). It was preserved. Open it in Finder and use Sliccy’s own updater if needed."
        case .invalidDownload:
            "The Sliccy download was incomplete or did not match the verified release. Nothing was installed. Try again."
        case .invalidBundle:
            "The downloaded app has an unexpected identity, version, or macOS requirement. Nothing was installed."
        case .commandFailed(let command):
            "Sliccy could not be installed (\(command) failed). Check your connection and available disk space, then try again."
        case .commandTimedOut(let command):
            "Sliccy installation timed out during \(command). Nothing was replaced. Try again."
        }
    }
}

/// No privileged helper and no replacement: publish a verified copy with an
/// exclusive atomic rename. Existing Sliccy and Sliccstart apps are never touched.
actor SliccyInstaller {
    struct Services {
        var download: (URL, URL) async throws -> Void = SliccyInstaller.download
        var run: (String, [String]) async throws -> Void = SliccyInstallCommand.run
        var existingApplication: () async -> URL? = {
            await MainActor.run { NSWorkspace.shared.urlForApplication(withBundleIdentifier: "ai.sliccy.mac") }
        }
        var quarantine: (URL) throws -> Void = SliccyInstaller.quarantine
    }

    static var applicationsDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true)
    }

    private let directory: URL
    private let temporaryDirectory: URL
    private let expectedSHA256: String
    private let osVersion: OperatingSystemVersion
    private let isAppleSilicon: Bool
    private let services: Services
    private var isInstalling = false

    init(
        directory: URL = SliccyInstaller.applicationsDirectory,
        temporaryDirectory: URL = FileManager.default.temporaryDirectory,
        expectedSHA256: String = SliccyRelease.sha256,
        osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
        isAppleSilicon: Bool = SliccyOffer.hostIsAppleSilicon,
        services: Services = Services()
    ) {
        self.directory = directory
        self.temporaryDirectory = temporaryDirectory
        self.expectedSHA256 = expectedSHA256
        self.osVersion = osVersion
        self.isAppleSilicon = isAppleSilicon
        self.services = services
    }

    func install(progress: @escaping @Sendable (String) async -> Void = { _ in }) async throws -> URL {
        guard osVersion.majorVersion >= SliccyRelease.minimumOSMajor, isAppleSilicon else { throw SliccyInstallError.unsupportedMac }
        guard !isInstalling else { throw SliccyInstallError.commandFailed("another installation is in progress") }
        isInstalling = true
        defer { isInstalling = false }
        let fm = FileManager.default
        if let existing = await services.existingApplication(), fm.fileExists(atPath: existing.path) {
            throw SliccyInstallError.alreadyInstalled(existing)
        }
        let destination = directory.appendingPathComponent("Sliccy.app", isDirectory: true)
        guard !fm.fileExists(atPath: destination.path) else { throw SliccyInstallError.alreadyInstalled(destination) }
        let scratch = temporaryDirectory.appendingPathComponent("sliccy-download-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: scratch, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let staging = directory.appendingPathComponent(".sliccy-install-\(UUID().uuidString)", isDirectory: true)
        let mount = scratch.appendingPathComponent("image", isDirectory: true)
        var mountAttempted = false
        do {
            await progress("Downloading Sliccy \(SliccyRelease.version)…")
            let image = scratch.appendingPathComponent("Sliccy.dmg")
            try await services.download(SliccyRelease.downloadURL, image)
            try Task.checkCancellation()
            let data = try Data(contentsOf: image, options: .mappedIfSafe)
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard hash == expectedSHA256 else { throw SliccyInstallError.invalidDownload }
            await progress("Verifying Sliccy…")
            try fm.createDirectory(at: mount, withIntermediateDirectories: false)
            mountAttempted = true
            try await services.run(
                "/usr/bin/hdiutil",
                [
                    "attach", "-readonly", "-nobrowse", "-noautoopen", "-quiet", "-mountpoint", mount.path, image.path,
                ])
            let source = mount.appendingPathComponent("Sliccy.app", isDirectory: true)
            try await validate(source)
            try Task.checkCancellation()
            await progress("Installing in ~/Applications…")
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            try fm.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let stagedApp = staging.appendingPathComponent("Sliccy.app", isDirectory: true)
            try fm.copyItem(at: source, to: stagedApp)
            try services.quarantine(stagedApp)
            try await validate(stagedApp)
            try await services.run("/usr/bin/hdiutil", ["detach", "-quiet", mount.path])
            mountAttempted = false
            try Task.checkCancellation()
            // RENAME_EXCL prevents a race from overwriting an app installed
            // by another process while this download was in flight.
            guard renamex_np(stagedApp.path, destination.path, UInt32(RENAME_EXCL)) == 0 else {
                if errno == EEXIST { throw SliccyInstallError.alreadyInstalled(destination) }
                throw CocoaError(.fileWriteUnknown)
            }
        } catch {
            await cleanup(scratch: scratch, staging: staging, mount: mount, mountAttempted: mountAttempted)
            if Task.isCancelled { throw CancellationError() }
            throw error
        }
        await cleanup(scratch: scratch, staging: staging, mount: mount, mountAttempted: false)
        return destination
    }

    private func cleanup(scratch: URL, staging: URL, mount: URL, mountAttempted: Bool) async {
        if mountAttempted {
            // Cleanup must still run when the download task was cancelled.
            // The runner has its own deadline; never force-detach a volume.
            let runner = services.run
            let detached = Task.detached { try await runner("/usr/bin/hdiutil", ["detach", "-quiet", mount.path]) }
            if (try? await detached.value) == nil {
                try? FileManager.default.removeItem(at: staging)
                return  // Preserve the mount directory if detaching failed.
            }
        }
        try? FileManager.default.removeItem(at: staging)
        try? FileManager.default.removeItem(at: scratch)
    }

    private func validate(_ app: URL) async throws {
        _ = try await SliccyApplicationValidator.validate(app, exactVersion: SliccyRelease.version, osVersion: osVersion, run: services.run)
    }

    private static func download(_ url: URL, to destination: URL) async throws {
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 180
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (file, response) = try await session.download(for: request)
        defer { try? FileManager.default.removeItem(at: file) }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
            http.url?.scheme == "https"
        else { throw SliccyInstallError.invalidDownload }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, response.expectedContentLength <= 0 || Int64(size) == response.expectedContentLength else {
            throw SliccyInstallError.invalidDownload
        }
        try FileManager.default.moveItem(at: file, to: destination)
    }

    private static func quarantine(_ app: URL) throws {
        let value = "0083;\(String(Int(Date().timeIntervalSince1970), radix: 16));Sliccstart;"
        let result = value.withCString { setxattr(app.path, "com.apple.quarantine", $0, value.utf8.count, 0, 0) }
        guard result == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
}
