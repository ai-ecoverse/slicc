import Foundation
import HuggingFace

/// One model present in the local HuggingFace hub cache.
struct CachedModel: Identifiable, Equatable, Hashable {
    /// HF repo ID, e.g. `mlx-community/gemma-4-26b-a4b-it-4bit`.
    let repoId: String
    /// Bytes occupied on disk under `~/.cache/huggingface/hub/models--…`.
    let sizeBytes: Int64

    var id: String { repoId }
}

/// Scan and delete entries in the standard HuggingFace hub cache.
///
/// `swift-huggingface`'s `HubCache` only exposes single-file lookups, no
/// list-all API, so we walk `~/.cache/huggingface/hub` directly. The
/// directory layout it uses (`models--<org>--<name>`) is the
/// well-documented Python format both clients share.
enum HFCache {
    /// Resolves the cache root from the same env vars `HubCache.default`
    /// reads, falling back to `~/.cache/huggingface/hub`.
    static var hubDirectory: URL {
        let cache = HubCache(location: .environment)
        return cache.metadataDirectory(repo: "_dummy_/_dummy_", kind: .model)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    /// All `mlx-community/...` repos present locally. Sorted by repo ID.
    /// Other namespaces (image/video models) are filtered out — the
    /// Models tab is for SwiftLM-runnable LLMs.
    static func listInstalledMLXModels() -> [CachedModel] {
        listInstalled().filter { $0.repoId.hasPrefix("mlx-community/") }
    }

    /// All cached repos under `models--<org>--<name>/`, sorted by repo ID.
    static func listInstalled() -> [CachedModel] {
        let fm = FileManager.default
        let root = hubDirectory
        guard let entries = try? fm.contentsOfDirectory(atPath: root.path) else {
            return []
        }

        var result: [CachedModel] = []
        for entry in entries where entry.hasPrefix("models--") {
            let dir = root.appendingPathComponent(entry, isDirectory: true)
            // `models--org--name` -> `org/name`. Split on the literal `--`
            // separator (model names themselves can contain dashes).
            let withoutPrefix = String(entry.dropFirst("models--".count))
            let parts = withoutPrefix.components(separatedBy: "--")
            guard parts.count >= 2 else { continue }
            let repoId = "\(parts[0])/\(parts.dropFirst().joined(separator: "--"))"
            let size = directorySize(at: dir)
            result.append(CachedModel(repoId: repoId, sizeBytes: size))
        }
        return result.sorted { $0.repoId < $1.repoId }
    }

    /// Removes the entire `models--<org>--<name>` directory for `repoId`.
    /// Safe to call on a model that isn't installed (no-op).
    static func delete(repoId: String) throws {
        let safeName = "models--" + repoId.replacingOccurrences(of: "/", with: "--")
        let dir = hubDirectory.appendingPathComponent(safeName, isDirectory: true)
        if FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.removeItem(at: dir)
        }
    }

    /// Sum of all file sizes under `dir`, following symlinks (HF cache
    /// uses content-addressed storage with snapshot symlinks).
    private static func directorySize(at dir: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(
            at: dir,
            includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey],
            options: []
        ) else {
            return 0
        }

        var total: Int64 = 0
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey])
            if values?.isRegularFile == true, let size = values?.totalFileAllocatedSize {
                total += Int64(size)
            }
        }
        return total
    }
}

extension Int64 {
    /// Human-readable size (e.g. `13.4 GB`). Uses ByteCountFormatter so the
    /// units match macOS Finder.
    var humanByteSize: String {
        ByteCountFormatter.string(fromByteCount: self, countStyle: .file)
    }
}
