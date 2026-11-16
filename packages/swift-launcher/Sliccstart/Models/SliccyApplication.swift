import Foundation

struct SliccyApplication: Equatable, Sendable {
    let url: URL
    let version: String
}

/// Shared trust checks for the pinned installer and native app discovery.
enum SliccyApplicationValidator {
    private struct Metadata: Decodable {
        let CFBundleIdentifier: String
        let CFBundleShortVersionString: String
        let CFBundleExecutable: String
        let LSMinimumSystemVersion: String
    }

    static func isInstalledLocation(_ url: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> Bool {
        let components = url.standardizedFileURL.pathComponents
        return [URL(fileURLWithPath: "/Applications"), home.appendingPathComponent("Applications")].contains {
            components.starts(with: $0.standardizedFileURL.pathComponents) && components.count > $0.pathComponents.count
        }
    }

    static func validate(
        _ url: URL,
        exactVersion: String? = nil,
        osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
        run: (String, [String]) async throws -> Void = SliccyInstallCommand.run
    ) async throws -> SliccyApplication {
        guard url.isFileURL, url.pathExtension == "app" else { throw SliccyInstallError.invalidBundle }
        let metadata = try PropertyListDecoder().decode(Metadata.self, from: Data(contentsOf: url.appendingPathComponent("Contents/Info.plist")))
        let host = "\(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)"
        guard metadata.CFBundleIdentifier == "ai.sliccy.mac", metadata.CFBundleExecutable == "Sliccy",
            metadata.CFBundleShortVersionString.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil,
            metadata.CFBundleShortVersionString.compare("7.0.0", options: .numeric) != .orderedAscending,
            exactVersion == nil || metadata.CFBundleShortVersionString == exactVersion,
            metadata.LSMinimumSystemVersion.range(of: #"^[0-9]+(\.[0-9]+){0,2}$"#, options: .regularExpression) != nil,
            host.compare(metadata.LSMinimumSystemVersion, options: .numeric) != .orderedAscending
        else { throw SliccyInstallError.invalidBundle }
        try await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", "-R", SliccyRelease.signingRequirement, url.path])
        try await run("/usr/bin/lipo", ["-verify_arch", "arm64", url.appendingPathComponent("Contents/MacOS/Sliccy").path])
        try await run("/usr/sbin/spctl", ["--assess", "--type", "execute", url.path])
        return SliccyApplication(url: url, version: metadata.CFBundleShortVersionString)
    }
}
