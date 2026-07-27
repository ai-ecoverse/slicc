import Foundation
import Security

enum SliccCliDownloadProgress: Equatable {
    case preparing
    case downloading(attempt: Int, totalAttempts: Int)
    case validating
    case installing
    case finished(URL)
}

enum SliccCliDownloadError: LocalizedError, Equatable {
    case networkFailure
    case invalidResponse(statusCode: Int?)
    case truncatedDownload(expectedBytes: Int64?, actualBytes: Int64)
    case nonExecutableResult
    case invalidCodeSignature
    case unexpectedSigningTeam(expected: String, actual: String?)
    case versionCheckFailed
    case fileSystemFailure(String)

    var errorDescription: String? {
        switch self {
        case .networkFailure:
            "Could not download the slicc CLI. Check your network connection and try again."
        case .invalidResponse(let statusCode):
            if let statusCode {
                "The slicc CLI download server returned HTTP \(statusCode). Try again later."
            } else {
                "The slicc CLI download server returned an invalid response."
            }
        case .truncatedDownload(let expected, let actual):
            if let expected {
                "The slicc CLI download was incomplete (received \(actual) of \(expected) bytes)."
            } else {
                "The slicc CLI download was empty."
            }
        case .nonExecutableResult:
            "The downloaded slicc CLI could not be made executable."
        case .invalidCodeSignature:
            "The downloaded slicc CLI is unsigned or has an invalid signature. It was not executed or installed."
        case .unexpectedSigningTeam(let expected, let actual):
            if let actual {
                "The downloaded slicc CLI was signed by unexpected team \(actual), not \(expected). It was not executed or installed."
            } else {
                "The downloaded slicc CLI has no signing team identifier. It was not executed or installed."
            }
        case .versionCheckFailed:
            "The downloaded slicc CLI failed its version check and was not installed."
        case .fileSystemFailure(let detail):
            "The slicc CLI could not be installed: \(detail)"
        }
    }
}

struct SliccCliCodeSignatureInspection: Equatable {
    let hasValidDeveloperIDSignature: Bool
    let teamIdentifier: String?
}

enum SliccCliCodeSignatureValidator {
    // Matches APPLE_TEAM_ID in the release workflow and the published Developer ID artifacts.
    static let expectedTeamIdentifier = "S8LB56P782"

    typealias Inspector = (URL) -> SliccCliCodeSignatureInspection

    static func validate(_ url: URL) throws {
        try validate(url, inspector: inspect)
    }

    static func validate(_ url: URL, inspector: Inspector) throws {
        let inspection = inspector(url)
        guard inspection.hasValidDeveloperIDSignature else {
            throw SliccCliDownloadError.invalidCodeSignature
        }
        guard inspection.teamIdentifier == expectedTeamIdentifier else {
            throw SliccCliDownloadError.unexpectedSigningTeam(
                expected: expectedTeamIdentifier,
                actual: inspection.teamIdentifier
            )
        }
    }

    private static func inspect(_ url: URL) -> SliccCliCodeSignatureInspection {
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess,
            let staticCode
        else {
            return .init(hasValidDeveloperIDSignature: false, teamIdentifier: nil)
        }

        var requirement: SecRequirement?
        let developerIDRequirement =
            "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
        guard
            SecRequirementCreateWithString(
                developerIDRequirement as CFString,
                [],
                &requirement
            ) == errSecSuccess,
            let requirement
        else {
            return .init(hasValidDeveloperIDSignature: false, teamIdentifier: nil)
        }

        let validationFlags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
        guard SecStaticCodeCheckValidity(staticCode, validationFlags, requirement) == errSecSuccess else {
            return .init(hasValidDeveloperIDSignature: false, teamIdentifier: nil)
        }

        var signingInformation: CFDictionary?
        let informationFlags = SecCSFlags(rawValue: kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(staticCode, informationFlags, &signingInformation) == errSecSuccess,
            let information = signingInformation as? [CFString: Any]
        else {
            return .init(hasValidDeveloperIDSignature: true, teamIdentifier: nil)
        }
        return .init(
            hasValidDeveloperIDSignature: true,
            teamIdentifier: information[kSecCodeInfoTeamIdentifier] as? String
        )
    }
}

final class SliccCliDownloader {
    static let downloadBaseURL = URL(string: "https://www.sliccy.ai/download/slicc-cli")!

    typealias ProgressHandler = (SliccCliDownloadProgress) -> Void
    typealias PermissionsApplier = (URL) throws -> Void
    typealias ExecutableChecker = (String) -> Bool
    typealias SignatureValidator = (URL) throws -> Void
    typealias VersionValidator = (URL) throws -> Bool

    private let session: URLSession
    private let fileManager: FileManager
    private let installDirectory: URL
    private let baseURL: URL
    private let requestTimeout: TimeInterval
    private let maxAttempts: Int
    private let retryDelayNanoseconds: UInt64
    private let permissionsApplier: PermissionsApplier
    private let executableChecker: ExecutableChecker
    private let signatureValidator: SignatureValidator
    private let versionValidator: VersionValidator
    private let progressHandler: ProgressHandler

    init(
        session: URLSession = .shared,
        fileManager: FileManager = .default,
        installDirectory: URL = SliccCliLocator.managedBinDirectory(),
        baseURL: URL = SliccCliDownloader.downloadBaseURL,
        requestTimeout: TimeInterval = 60,
        maxAttempts: Int = 3,
        retryDelayNanoseconds: UInt64 = 500_000_000,
        permissionsApplier: @escaping PermissionsApplier = SliccCliDownloader.applyExecutablePermissions,
        executableChecker: @escaping ExecutableChecker = FileManager.default.isExecutableFile,
        signatureValidator: @escaping SignatureValidator = SliccCliCodeSignatureValidator.validate,
        versionValidator: @escaping VersionValidator = SliccCliDownloader.validateVersion,
        progressHandler: @escaping ProgressHandler = { _ in }
    ) {
        self.session = session
        self.fileManager = fileManager
        self.installDirectory = installDirectory
        self.baseURL = baseURL
        self.requestTimeout = requestTimeout
        self.maxAttempts = max(1, maxAttempts)
        self.retryDelayNanoseconds = retryDelayNanoseconds
        self.permissionsApplier = permissionsApplier
        self.executableChecker = executableChecker
        self.signatureValidator = signatureValidator
        self.versionValidator = versionValidator
        self.progressHandler = progressHandler
    }

    func download(architecture: SliccCliArchitecture = .current) async throws -> URL {
        progressHandler(.preparing)
        try createInstallDirectory()

        let destination = installDirectory.appendingPathComponent("slicc")
        if executableChecker(destination.path) {
            progressHandler(.finished(destination))
            return destination
        }

        let downloadURL = baseURL.appendingPathComponent("darwin-\(architecture.rawValue)")
        let (data, response) = try await fetch(downloadURL)
        try validateLength(data: data, response: response)

        let staging = installDirectory.appendingPathComponent(".slicc.download-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: staging) }
        try write(data, to: staging)

        progressHandler(.validating)
        try signatureValidator(staging)
        try makeExecutable(staging)
        guard executableChecker(staging.path) else {
            throw SliccCliDownloadError.nonExecutableResult
        }
        guard (try? versionValidator(staging)) == true else {
            throw SliccCliDownloadError.versionCheckFailed
        }

        progressHandler(.installing)
        try install(staging: staging, destination: destination)
        progressHandler(.finished(destination))
        return destination
    }

    private func fetch(_ url: URL) async throws -> (Data, HTTPURLResponse) {
        for attempt in 1...maxAttempts {
            progressHandler(.downloading(attempt: attempt, totalAttempts: maxAttempts))
            var request = URLRequest(url: url)
            request.timeoutInterval = requestTimeout
            do {
                let (data, response) = try await session.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw SliccCliDownloadError.invalidResponse(statusCode: nil)
                }
                if (200..<300).contains(httpResponse.statusCode) {
                    return (data, httpResponse)
                }
                if httpResponse.statusCode >= 500, attempt < maxAttempts {
                    try await waitBeforeRetry()
                    continue
                }
                throw SliccCliDownloadError.invalidResponse(statusCode: httpResponse.statusCode)
            } catch let error as SliccCliDownloadError {
                throw error
            } catch {
                if Task.isCancelled { throw CancellationError() }
                if attempt < maxAttempts {
                    try await waitBeforeRetry()
                    continue
                }
                throw SliccCliDownloadError.networkFailure
            }
        }
        throw SliccCliDownloadError.networkFailure
    }

    private func waitBeforeRetry() async throws {
        guard retryDelayNanoseconds > 0 else { return }
        try await Task.sleep(nanoseconds: retryDelayNanoseconds)
    }

    private func validateLength(data: Data, response: HTTPURLResponse) throws {
        let actual = Int64(data.count)
        let expected = response.expectedContentLength
        if actual == 0 {
            throw SliccCliDownloadError.truncatedDownload(expectedBytes: nil, actualBytes: 0)
        }
        if expected > 0, expected != actual {
            throw SliccCliDownloadError.truncatedDownload(expectedBytes: expected, actualBytes: actual)
        }
    }

    private func createInstallDirectory() throws {
        do {
            try fileManager.createDirectory(at: installDirectory, withIntermediateDirectories: true)
        } catch {
            throw SliccCliDownloadError.fileSystemFailure(error.localizedDescription)
        }
    }

    private func write(_ data: Data, to staging: URL) throws {
        do {
            try data.write(to: staging, options: .atomic)
        } catch {
            throw SliccCliDownloadError.fileSystemFailure(error.localizedDescription)
        }
    }

    private func makeExecutable(_ staging: URL) throws {
        do {
            try permissionsApplier(staging)
        } catch {
            throw SliccCliDownloadError.fileSystemFailure(error.localizedDescription)
        }
    }

    private func install(staging: URL, destination: URL) throws {
        do {
            if fileManager.fileExists(atPath: destination.path) {
                _ = try fileManager.replaceItemAt(destination, withItemAt: staging)
            } else {
                try fileManager.moveItem(at: staging, to: destination)
            }
        } catch {
            throw SliccCliDownloadError.fileSystemFailure(error.localizedDescription)
        }
    }

    private static func applyExecutablePermissions(to url: URL) throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    private static func validateVersion(at url: URL) throws -> Bool {
        let process = Process()
        process.executableURL = url
        process.arguments = ["--version"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus == 0
    }
}
