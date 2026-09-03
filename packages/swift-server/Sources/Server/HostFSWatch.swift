import CoreServices
import Foundation

/// Watch configured hostfs mount roots and broadcast `hostfs_invalidate`
/// over `/licks-ws` so the webapp can drop RemoteMountCache keys when the
/// OS changes a file outside SLICC. Mirrors node-server `hostfs-watch.ts`.
final class HostFSWatch: @unchecked Sendable {
    /// Process-lifetime retain so FSEventStream unretained callbacks stay valid.
    static var shared: HostFSWatch?

    static let debounceMs: Int = 75
    static let maxPathsPerEvent: Int = 64

    private let lickSystem: LickSystem
    private let queue = DispatchQueue(label: "slicc.hostfs-watch")
    private var streams: [FSEventStreamRef] = []
    private var pending: [String: Set<String>] = [:]
    private var flushWorkItem: DispatchWorkItem?
    private var rootByMount: [String: String] = [:]

    init(lickSystem: LickSystem) {
        self.lickSystem = lickSystem
    }

    /// Start one FSEventStream per mount root. Failures are logged and skipped.
    func start(roots: [HostFSRoutes.MountRoot]) {
        queue.sync {
            stopLocked()
            for root in roots {
                self.rootByMount[root.path] = root.root
                guard let stream = Self.makeStream(root: root.root, mount: root.path, watch: self) else {
                    print("[hostfs-watch] failed to watch \(root.root) (\(root.path))")
                    continue
                }
                FSEventStreamSetDispatchQueue(stream, self.queue)
                if !FSEventStreamStart(stream) {
                    FSEventStreamInvalidate(stream)
                    FSEventStreamRelease(stream)
                    print("[hostfs-watch] failed to start stream for \(root.root)")
                    continue
                }
                self.streams.append(stream)
                print("[hostfs-watch] watching \(root.root) → \(root.path)")
            }
        }
    }

    func stop() {
        queue.sync { stopLocked() }
    }

    private func stopLocked() {
        flushWorkItem?.cancel()
        flushWorkItem = nil
        pending.removeAll()
        for stream in streams {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
        streams.removeAll()
        rootByMount.removeAll()
    }

    fileprivate func note(mount: String, absolutePath: String) {
        let root = rootByMount[mount] ?? ""
        let rel = Self.toMountRelativePath(root: root, absolutePath: absolutePath)
        var set = pending[mount] ?? []
        set.insert(rel)
        pending[mount] = set

        flushWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.flush()
        }
        flushWorkItem = work
        queue.asyncAfter(deadline: .now() + .milliseconds(Self.debounceMs), execute: work)
    }

    private func flush() {
        flushWorkItem = nil
        let batch = pending
        pending.removeAll()
        for (mount, paths) in batch {
            let event = Self.buildEvent(mount: mount, paths: paths)
            Task { await lickSystem.broadcastLickEvent(event) }
        }
    }

    /// Map an absolute host path onto a mount-relative POSIX path. Empty string
    /// means "whole mount / unknown" and clears the cache on the client.
    static func toMountRelativePath(root: String, absolutePath: String) -> String {
        let normalizedRoot = (root as NSString).standardizingPath
        let normalizedPath = (absolutePath as NSString).standardizingPath
        if normalizedPath == normalizedRoot { return "" }
        let prefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : normalizedRoot + "/"
        guard normalizedPath.hasPrefix(prefix) else { return "" }
        return String(normalizedPath.dropFirst(prefix.count))
    }

    static func buildEvent(mount: String, paths: Set<String>) -> LickSystem.JSONObject {
        let unique = Array(paths)
        let clearAll = unique.contains("") || unique.count > maxPathsPerEvent
        return [
            "type": .string("hostfs_invalidate"),
            "mount": .string(mount),
            "paths": .array(clearAll ? [] : unique.map { .string($0) }),
            "timestamp": .string(ISO8601DateFormatter().string(from: Date())),
        ]
    }

    private static func makeStream(root: String, mount: String, watch: HostFSWatch) -> FSEventStreamRef? {
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(watch).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let paths = [root] as CFArray
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagUseCFTypes
                | kFSEventStreamCreateFlagNoDefer
        )
        let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, _, _ in
            guard let info else { return }
            let watch = Unmanaged<HostFSWatch>.fromOpaque(info).takeUnretainedValue()
            // With UseCFTypes, eventPaths is a CFArray of CFString paths.
            let cfPaths = Unmanaged<CFArray>.fromOpaque(eventPaths).takeUnretainedValue()
            let paths = cfPaths as? [String] ?? []
            for path in paths.prefix(numEvents) {
                if let mount = watch.mountFor(absolutePath: path) {
                    watch.note(mount: mount, absolutePath: path)
                }
            }
        }
        return FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.1,
            flags
        )
    }

    fileprivate func mountFor(absolutePath: String) -> String? {
        let normalized = (absolutePath as NSString).standardizingPath
        for (mount, root) in rootByMount {
            let normalizedRoot = (root as NSString).standardizingPath
            if normalized == normalizedRoot { return mount }
            let prefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : normalizedRoot + "/"
            if normalized.hasPrefix(prefix) { return mount }
        }
        return nil
    }
}
