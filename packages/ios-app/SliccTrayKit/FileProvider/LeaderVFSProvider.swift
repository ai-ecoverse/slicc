import FileProvider
import Foundation
import UniformTypeIdentifiers

@MainActor
public protocol FileProviderFSClient: AnyObject {
    func readBinaryFile(_ path: String) async throws -> Data
    func readDir(_ path: String) async throws -> [TrayFsDirEntry]
    func stat(_ path: String) async throws -> TrayFsStat
}

extension FsClient: FileProviderFSClient {}

public enum VFSItemIdentity {
    private static let prefix = "vfs:"

    public static func identifier(for path: String) throws -> NSFileProviderItemIdentifier {
        let path = try canonicalPath(path)
        if path == "/" { return .rootContainer }
        let encoded = Data(path.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return NSFileProviderItemIdentifier(rawValue: prefix + encoded)
    }

    public static func path(for identifier: NSFileProviderItemIdentifier) throws -> String {
        if identifier == .rootContainer { return "/" }
        guard identifier.rawValue.hasPrefix(prefix) else {
            throw VFSProviderError.invalidIdentifier
        }
        var encoded = String(identifier.rawValue.dropFirst(prefix.count))
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded), let path = String(data: data, encoding: .utf8)
        else { throw VFSProviderError.invalidIdentifier }
        return try canonicalPath(path)
    }

    public static func canonicalPath(_ rawPath: String) throws -> String {
        guard rawPath.first == "/", !rawPath.utf8.contains(0) else {
            throw VFSProviderError.invalidPath
        }
        var components: [Substring] = []
        for component in rawPath.split(separator: "/", omittingEmptySubsequences: true) {
            switch component {
            case ".": continue
            case "..":
                guard !components.isEmpty else { throw VFSProviderError.invalidPath }
                components.removeLast()
            default: components.append(component)
            }
        }
        return components.isEmpty ? "/" : "/" + components.joined(separator: "/")
    }

    static func childPath(parent: String, name: String) throws -> String {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.utf8.contains(0)
        else { throw VFSProviderError.invalidPath }
        return try canonicalPath(parent == "/" ? "/\(name)" : "\(parent)/\(name)")
    }
}

public enum VFSProviderError: Error, Equatable {
    case missingCredentials
    case serverUnreachable
    case noSuchItem
    case invalidIdentifier
    case invalidPath
}

public enum VFSProviderErrorMapper {
    public static func map(_ error: Error) -> Error {
        let code: NSFileProviderError.Code
        switch error {
        case VFSProviderError.missingCredentials:
            code = .notAuthenticated
        case VFSProviderError.noSuchItem,
            VFSProviderError.invalidIdentifier,
            VFSProviderError.invalidPath:
            code = .noSuchItem
        case let fsError as FsClient.FsError:
            if case .leader(_, let leaderCode) = fsError, leaderCode == "ENOENT" {
                code = .noSuchItem
            } else {
                code = .serverUnreachable
            }
        default:
            code = .serverUnreachable
        }
        return NSFileProviderError(code)
    }
}

public final class LeaderVFSItem: NSObject, NSFileProviderItemProtocol {
    public let itemIdentifier: NSFileProviderItemIdentifier
    public let parentItemIdentifier: NSFileProviderItemIdentifier
    public let filename: String
    public let contentType: UTType
    public let capabilities: NSFileProviderItemCapabilities
    public let documentSize: NSNumber?
    public let contentModificationDate: Date?
    public let creationDate: Date?
    public let itemVersion: NSFileProviderItemVersion
    public let path: String

    public init(path rawPath: String, stat: TrayFsStat? = nil) throws {
        let path = try VFSItemIdentity.canonicalPath(rawPath)
        self.path = path
        itemIdentifier = try VFSItemIdentity.identifier(for: path)
        if path == "/" {
            parentItemIdentifier = .rootContainer
            filename = "SLICC"
        } else {
            let parent = (path as NSString).deletingLastPathComponent
            parentItemIdentifier = try VFSItemIdentity.identifier(for: parent.isEmpty ? "/" : parent)
            filename = (path as NSString).lastPathComponent
        }

        switch stat?.type ?? .directory {
        case .directory:
            contentType = .folder
            capabilities = [.allowsContentEnumerating]
        case .file:
            contentType = UTType(filenameExtension: (filename as NSString).pathExtension) ?? .data
            capabilities = [.allowsReading]
        case .symlink:
            contentType = .item
            capabilities = [.allowsReading]
        }
        documentSize = stat.map { NSNumber(value: $0.size) }
        contentModificationDate = stat.map { Date(timeIntervalSince1970: $0.mtime / 1_000) }
        creationDate = stat.map { Date(timeIntervalSince1970: $0.ctime / 1_000) }
        let version = stat.map { "\($0.type.rawValue):\($0.size):\($0.mtime):\($0.ctime)" } ?? "root"
        let versionData = Data(version.utf8)
        itemVersion = NSFileProviderItemVersion(contentVersion: versionData, metadataVersion: versionData)
        super.init()
    }
}

public struct LeaderVFSChangeSet {
    public let updated: [LeaderVFSItem]
    public let deleted: [NSFileProviderItemIdentifier]
    public let anchor: NSFileProviderSyncAnchor
}

@MainActor
public final class LeaderVFSProvider {
    private struct Change {
        let anchor: UInt64
        let updated: [LeaderVFSItem]
        let deleted: [NSFileProviderItemIdentifier]
    }

    private let fs: FileProviderFSClient
    private var itemsByPath: [String: LeaderVFSItem] = [:]
    private var childrenByDirectory: [String: Set<String>] = [:]
    private var knownDirectories: Set<String> = ["/"]
    private var changes: [Change] = []
    private var anchor: UInt64 = 0

    public init(fs: FileProviderFSClient) {
        self.fs = fs
        do {
            let root = try LeaderVFSItem(path: "/")
            itemsByPath["/"] = root
        } catch {
            assertionFailure("The canonical VFS root must always be representable: \(error)")
        }
    }

    public func item(for identifier: NSFileProviderItemIdentifier) async throws -> LeaderVFSItem {
        let path = try allowedPath(for: identifier)
        if path == "/" { return try LeaderVFSItem(path: "/") }
        let stat = try await fsStat(path)
        let item = try LeaderVFSItem(path: path, stat: stat)
        record(updated: [item], deleted: [])
        itemsByPath[path] = item
        return item
    }

    public func items(for container: NSFileProviderItemIdentifier) async throws -> [LeaderVFSItem] {
        if container == .workingSet {
            if childrenByDirectory["/"] == nil { _ = try await refreshDirectory("/") }
            return itemsByPath.values.filter { $0.path != "/" }.sorted { $0.path < $1.path }
        }
        return try await refreshDirectory(allowedPath(for: container))
    }

    public func enumerator(for container: NSFileProviderItemIdentifier) throws -> LeaderVFSEnumerator {
        do {
            if container != .workingSet { _ = try allowedPath(for: container) }
            return LeaderVFSEnumerator(provider: self, container: container)
        } catch {
            throw VFSProviderErrorMapper.map(error)
        }
    }

    public func fetchContents(for identifier: NSFileProviderItemIdentifier) async throws
        -> (Data, LeaderVFSItem)
    {
        let path = try allowedPath(for: identifier)
        guard path != "/" else { throw VFSProviderError.noSuchItem }
        async let data = fs.readBinaryFile(path)
        async let stat = fs.stat(path)
        let result = try await (data, stat)
        let item = try LeaderVFSItem(path: path, stat: result.1)
        itemsByPath[path] = item
        record(updated: [item], deleted: [])
        return (result.0, item)
    }

    public func changes(from syncAnchor: NSFileProviderSyncAnchor) async throws -> LeaderVFSChangeSet {
        let requested = Self.decode(anchor: syncAnchor)
        for path in knownDirectories.sorted() where knownDirectories.contains(path) {
            _ = try await refreshDirectory(path)
        }

        var updated: [NSFileProviderItemIdentifier: LeaderVFSItem] = [:]
        var deleted = Set<NSFileProviderItemIdentifier>()
        for change in changes where change.anchor > requested {
            for item in change.updated {
                updated[item.itemIdentifier] = item
                deleted.remove(item.itemIdentifier)
            }
            for identifier in change.deleted {
                updated.removeValue(forKey: identifier)
                deleted.insert(identifier)
            }
        }
        return LeaderVFSChangeSet(
            updated: updated.values.sorted { $0.path < $1.path },
            deleted: deleted.sorted { $0.rawValue < $1.rawValue },
            anchor: currentSyncAnchor())
    }

    public func currentSyncAnchor() -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(rawValue: Data(String(anchor).utf8))
    }

    private func refreshDirectory(_ rawPath: String) async throws -> [LeaderVFSItem] {
        let path = try VFSItemIdentity.canonicalPath(rawPath)
        guard !Self.isProc(path) else { throw VFSProviderError.noSuchItem }
        let entries = try await fs.readDir(path)
        var freshItems: [LeaderVFSItem] = []
        for entry in entries {
            let childPath = try VFSItemIdentity.childPath(parent: path, name: entry.name)
            if Self.isProc(childPath) { continue }
            let stat = try await fsStat(childPath)
            let item = try LeaderVFSItem(path: childPath, stat: stat)
            freshItems.append(item)
            if entry.type == .directory { knownDirectories.insert(childPath) }
        }

        let oldPaths = childrenByDirectory[path] ?? []
        let freshPaths = Set(freshItems.map(\.path))
        let deletedPaths = oldPaths.subtracting(freshPaths)
        let deleted = deletedPaths.flatMap { purgeSubtree(root: $0) }
        var updated: [LeaderVFSItem] = []
        for item in freshItems {
            if itemsByPath[item.path]?.itemVersion != item.itemVersion { updated.append(item) }
            itemsByPath[item.path] = item
        }
        childrenByDirectory[path] = freshPaths
        record(updated: updated, deleted: deleted)
        return freshItems.sorted { $0.filename.localizedStandardCompare($1.filename) == .orderedAscending }
    }

    private func purgeSubtree(root: String) -> [NSFileProviderItemIdentifier] {
        let prefix = root + "/"
        let stalePaths = itemsByPath.keys.filter { $0 == root || $0.hasPrefix(prefix) }
        let deleted = stalePaths.compactMap { itemsByPath[$0]?.itemIdentifier }
        for stalePath in stalePaths { itemsByPath.removeValue(forKey: stalePath) }
        knownDirectories = knownDirectories.filter { $0 != root && !$0.hasPrefix(prefix) }
        childrenByDirectory = childrenByDirectory.filter { key, _ in
            key != root && !key.hasPrefix(prefix)
        }
        return deleted
    }

    private func fsStat(_ path: String) async throws -> TrayFsStat {
        try await fs.stat(path)
    }

    private func allowedPath(for identifier: NSFileProviderItemIdentifier) throws -> String {
        let path = try VFSItemIdentity.path(for: identifier)
        guard !Self.isProc(path) else { throw VFSProviderError.noSuchItem }
        return path
    }

    private func record(
        updated: [LeaderVFSItem], deleted: [NSFileProviderItemIdentifier]
    ) {
        guard !updated.isEmpty || !deleted.isEmpty else { return }
        anchor += 1
        changes.append(Change(anchor: anchor, updated: updated, deleted: deleted))
        if changes.count > 100 { changes.removeFirst(changes.count - 100) }
    }

    private static func decode(anchor: NSFileProviderSyncAnchor) -> UInt64 {
        String(data: anchor.rawValue, encoding: .utf8).flatMap(UInt64.init) ?? 0
    }

    private static func isProc(_ path: String) -> Bool {
        path == "/proc" || path.hasPrefix("/proc/")
    }
}

public final class LeaderVFSEnumerator: NSObject, NSFileProviderEnumerator {
    private let provider: LeaderVFSProvider
    private let container: NSFileProviderItemIdentifier

    public init(provider: LeaderVFSProvider, container: NSFileProviderItemIdentifier) {
        self.provider = provider
        self.container = container
    }

    public func invalidate() {}

    public func enumerateItems(
        for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage
    ) {
        Task { @MainActor in
            do {
                observer.didEnumerate(try await provider.items(for: container))
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(VFSProviderErrorMapper.map(error))
            }
        }
    }

    public func enumerateChanges(
        for observer: NSFileProviderChangeObserver, from syncAnchor: NSFileProviderSyncAnchor
    ) {
        Task { @MainActor in
            do {
                let changes = try await provider.changes(from: syncAnchor)
                observer.didUpdate(changes.updated)
                observer.didDeleteItems(withIdentifiers: changes.deleted)
                observer.finishEnumeratingChanges(upTo: changes.anchor, moreComing: false)
            } catch {
                observer.finishEnumeratingWithError(VFSProviderErrorMapper.map(error))
            }
        }
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task { @MainActor in completionHandler(provider.currentSyncAnchor()) }
    }
}
