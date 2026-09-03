import CoreServices
import Foundation

/// Watch configured hostfs mount roots and broadcast `hostfs_invalidate`
/// over `/licks-ws` so the webapp can drop RemoteMountCache keys when the
/// OS changes a file outside SLICC. Mirrors node-server `hostfs-watch.ts`.
final class HostFSWatch: @unchecked Sendable {
    private final class StreamContext {
        unowned let watch: HostFSWatch
        let mount: String
        let root: String

        init(watch: HostFSWatch, mount: String, root: String) {
            self.watch = watch
            self.mount = mount
            self.root = root
        }
    }

    /// Process-lifetime retain so FSEventStream unretained callbacks stay valid.
    static var shared: HostFSWatch?

    static let debounceMs: Int = 75
    static let maxPathsPerEvent: Int = 64

    private let lickSystem: LickSystem
    private let queue = DispatchQueue(label: "slicc.hostfs-watch")
    private var streams: [FSEventStreamRef] = []
    /// Retains the unretained pointers installed in each FSEventStream context.
    private var streamContexts: [StreamContext] = []
    private var pending: [String: Set<String>] = [:]
    private var flushWorkItems: [String: DispatchWorkItem] = [:]

    init(lickSystem: LickSystem) {
        self.lickSystem = lickSystem
    }

    /// Start one FSEventStream per mount root. Failures are logged and skipped.
    func start(roots: [HostFSRoutes.MountRoot]) {
        queue.sync {
            stopLocked()
            for root in roots {
                let context = StreamContext(watch: self, mount: root.path, root: root.root)
                guard let stream = Self.makeStream(context: context) else {
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
                self.streamContexts.append(context)
                print("[hostfs-watch] watching \(root.root) → \(root.path)")
            }
        }
    }

    func stop() {
        queue.sync { stopLocked() }
    }

    private func stopLocked() {
        for work in flushWorkItems.values {
            work.cancel()
        }
        flushWorkItems.removeAll()
        pending.removeAll()
        for stream in streams {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
        streams.removeAll()
        streamContexts.removeAll()
    }

    fileprivate func note(mount: String, root: String, absolutePath: String) {
        let rel = Self.toMountRelativePath(root: root, absolutePath: absolutePath)
        var set = pending[mount] ?? []
        set.insert(rel)
        pending[mount] = set

        flushWorkItems[mount]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.flush(mount: mount)
        }
        flushWorkItems[mount] = work
        queue.asyncAfter(deadline: .now() + .milliseconds(Self.debounceMs), execute: work)
    }

    private func flush(mount: String) {
        flushWorkItems.removeValue(forKey: mount)
        guard let paths = pending.removeValue(forKey: mount) else { return }
        let event = Self.buildEvent(mount: mount, paths: paths)
        Task { await lickSystem.broadcastLickEvent(event) }
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

    private static func makeStream(context streamContext: StreamContext) -> FSEventStreamRef? {
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(streamContext).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let paths = [streamContext.root] as CFArray
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagUseCFTypes
                | kFSEventStreamCreateFlagNoDefer
        )
        let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, _, _ in
            guard let info else { return }
            let context = Unmanaged<StreamContext>.fromOpaque(info).takeUnretainedValue()
            // With UseCFTypes, eventPaths is a CFArray of CFString paths.
            let cfPaths = Unmanaged<CFArray>.fromOpaque(eventPaths).takeUnretainedValue()
            let paths = cfPaths as? [String] ?? []
            for path in paths.prefix(numEvents) {
                context.watch.note(
                    mount: context.mount,
                    root: context.root,
                    absolutePath: path
                )
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
}
