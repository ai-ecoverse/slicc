import Foundation

/// Pinned `SharpAI/SwiftLM` release that Sliccstart auto-downloads on first
/// launch (and whenever the bundled binary's recorded version doesn't match).
///
/// Bumped automatically by Renovate via the `customManagers` rule in
/// `renovate.json` matching the `// renovate:` marker below. SwiftLM's tags
/// look like `b602` rather than semver, hence `versioning=loose`.
enum SwiftLMVersion {
    // renovate: datasource=github-releases depName=SharpAI/SwiftLM versioning=loose
    static let pinned = "b644"

    /// Released asset name for the macOS arm64 build. SwiftLM ships one
    /// tarball per release with the version baked into the file name.
    static var releaseAssetName: String { "SwiftLM-\(pinned)-macos-arm64.tar.gz" }

    /// URL of the release tarball on GitHub.
    static var releaseURL: URL {
        URL(string: "https://github.com/SharpAI/SwiftLM/releases/download/\(pinned)/\(releaseAssetName)")!
    }
}
