import Foundation
import HTTPTypes
import Hummingbird
import NIOCore

/// Host filesystem bridge — serves the folders named in the mount table
/// (`--mount <os-path>:<slicc-path>`, fed by Sliccstart's Settings → Mounts)
/// to the webapp over the local /api surface, so configured mounts appear in
/// the VFS fully automatically: no File System Access picker, no Chrome
/// permission prompt. Picker-initiated mounts are unaffected.
///
/// Mirrors node-server's `src/hostfs.ts` 1:1 — same routes, same JSON error
/// shape (`{ code, message }` with an errno-derived status), same traversal
/// and symlink containment rules — so the webapp's `HostFsMountBackend`
/// works identically against both servers.
enum HostFSRoutes {
    /// Matches the webapp's hostfs body cap (`backend-hostfs.ts`).
    static let maxBodyBytes = 100 * 1024 * 1024

    struct MountRoot: Sendable, Equatable {
        /// SLICC target path, e.g. `/mnt/project`.
        let path: String
        /// Symlink-resolved OS root.
        let root: String
    }

    /// Resolve the configured mappings to symlink-resolved roots, dropping
    /// mappings whose OS folder does not exist or is not a directory — a
    /// missing folder must not take the /api surface down.
    static func resolveRoots(
        mounts: [ServerConfig.MountMapping],
        warn: (String) -> Void = { print($0) }
    ) -> [MountRoot] {
        var roots: [MountRoot] = []
        for mapping in mounts {
            let resolved = URL(fileURLWithPath: mapping.hostPath).resolvingSymlinksInPath().path
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: resolved, isDirectory: &isDirectory),
                isDirectory.boolValue
            else {
                warn("--mount \(mapping.hostPath): not an existing directory, skipping")
                continue
            }
            roots.append(MountRoot(path: mapping.path, root: resolved))
        }
        return roots
    }

    enum FsFailure: Error {
        case code(String, HTTPResponse.Status, String)
    }

    /// Resolve `relPath` against `root`, rejecting lexical (`..`) and
    /// symlink escapes. Symlinks inside the root that stay inside the root
    /// are followed; the nearest existing ancestor of a not-yet-existing
    /// target must also resolve inside the root, so writes are validated too.
    static func resolveWithinRoot(root: String, relPath: String) throws -> String {
        let cleaned = relPath.drop(while: { $0 == "/" })
        let target = URL(fileURLWithPath: root).appendingPathComponent(String(cleaned))
            .standardizedFileURL.path
        func isWithin(_ candidate: String) -> Bool {
            candidate == root || candidate.hasPrefix(root + "/")
        }
        guard isWithin(target) else {
            throw FsFailure.code("EACCES", .forbidden, "path escapes the mount root")
        }
        var probe = target
        while true {
            if FileManager.default.fileExists(atPath: probe) {
                let real = URL(fileURLWithPath: probe).resolvingSymlinksInPath().path
                if !isWithin(real) && probe != root {
                    throw FsFailure.code("EACCES", .forbidden, "path escapes the mount root")
                }
                break
            }
            let parent = URL(fileURLWithPath: probe).deletingLastPathComponent().path
            if parent == probe { break }
            probe = parent
        }
        return target
    }

    // MARK: - Registration

    static func registerRoutes(router: Router<some RequestContext>, roots: [MountRoot]) {
        let byPath = Dictionary(uniqueKeysWithValues: roots.map { ($0.path, $0) })

        @Sendable func target(for request: Request, pathParam: String = "path") throws -> String {
            let mount = String(request.uri.queryParameters["mount"] ?? "")
            guard let entry = byPath[mount] else {
                throw FsFailure.code("ENOENT", .notFound, "no such mount: \(mount)")
            }
            let rel = String(request.uri.queryParameters[Substring(pathParam)] ?? "")
            return try resolveWithinRoot(root: entry.root, relPath: rel)
        }

        router.get("/api/hostfs/list") { request, _ in
            try run {
                let dir = try target(for: request)
                let names = try wrapErrno { try FileManager.default.contentsOfDirectory(atPath: dir) }
                let entries: [LickSystem.JSONValue] = names.map { name in
                    let full = dir + "/" + name
                    var isDirectory: ObjCBool = false
                    FileManager.default.fileExists(atPath: full, isDirectory: &isDirectory)
                    if isDirectory.boolValue {
                        return .object(["name": .string(name), "kind": .string("directory")])
                    }
                    let attrs = try? FileManager.default.attributesOfItem(atPath: full)
                    let size = (attrs?[.size] as? NSNumber)?.doubleValue ?? 0
                    let mtime = (attrs?[.modificationDate] as? Date).map { $0.timeIntervalSince1970 * 1000 } ?? 0
                    return .object([
                        "name": .string(name),
                        "kind": .string("file"),
                        "size": .number(size),
                        "lastModified": .number(mtime.rounded()),
                    ])
                }
                return try jsonBody(.object(["entries": .array(entries)]))
            }
        }

        router.get("/api/hostfs/stat") { request, _ in
            try run {
                let path = try target(for: request)
                let (isDirectory, size, mtime) = try statAt(path)
                return try jsonBody(
                    .object([
                        "kind": .string(isDirectory ? "directory" : "file"),
                        "size": .number(isDirectory ? 0 : size),
                        "mtime": .number(mtime),
                    ]))
            }
        }

        router.get("/api/hostfs/read") { request, _ in
            try run {
                let path = try target(for: request)
                let (isDirectory, size, _) = try statAt(path)
                if isDirectory {
                    throw FsFailure.code("EISDIR", .conflict, "is a directory")
                }
                if size > Double(maxBodyBytes) {
                    throw FsFailure.code("EFBIG", .contentTooLarge, "file exceeds the hostfs cap")
                }
                let data = try wrapErrno { try Data(contentsOf: URL(fileURLWithPath: path)) }
                var headers = HTTPFields()
                headers[.contentType] = "application/octet-stream"
                return Response(
                    status: .ok, headers: headers, body: .init(byteBuffer: ByteBuffer(bytes: data)))
            }
        }

        router.put("/api/hostfs/write") { request, _ in
            var body: Data
            do {
                var buffer = try await request.body.collect(upTo: maxBodyBytes)
                body = buffer.readData(length: buffer.readableBytes) ?? Data()
            } catch {
                return fsError("EFBIG", .contentTooLarge, "body exceeds the hostfs cap")
            }
            return try run {
                let path = try target(for: request)
                var isDirectory: ObjCBool = false
                if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
                    isDirectory.boolValue
                {
                    throw FsFailure.code("EISDIR", .conflict, "is a directory")
                }
                let parent = URL(fileURLWithPath: path).deletingLastPathComponent()
                try wrapErrno {
                    try FileManager.default.createDirectory(
                        at: parent, withIntermediateDirectories: true)
                    try body.write(to: URL(fileURLWithPath: path))
                }
                return try jsonBody(.object(["ok": .bool(true)]))
            }
        }

        router.post("/api/hostfs/mkdir") { request, _ in
            try run {
                let path = try target(for: request)
                try wrapErrno {
                    try FileManager.default.createDirectory(
                        atPath: path, withIntermediateDirectories: true)
                }
                return try jsonBody(.object(["ok": .bool(true)]))
            }
        }

        router.post("/api/hostfs/rename") { request, _ in
            try run {
                let from = try target(for: request)
                let to = try target(for: request, pathParam: "to")
                try wrapErrno { try FileManager.default.moveItem(atPath: from, toPath: to) }
                return try jsonBody(.object(["ok": .bool(true)]))
            }
        }

        router.delete("/api/hostfs/remove") { request, _ in
            try run {
                let path = try target(for: request)
                if roots.contains(where: { $0.root == path }) {
                    throw FsFailure.code("EACCES", .forbidden, "refusing to remove a mount root")
                }
                let recursive = String(request.uri.queryParameters["recursive"] ?? "") == "1"
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
                    throw FsFailure.code("ENOENT", .notFound, "no such file or directory")
                }
                if isDirectory.boolValue && !recursive {
                    let contents =
                        (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
                    if !contents.isEmpty {
                        throw FsFailure.code("ENOTEMPTY", .conflict, "directory not empty")
                    }
                }
                try wrapErrno { try FileManager.default.removeItem(atPath: path) }
                return try jsonBody(.object(["ok": .bool(true)]))
            }
        }
    }

    // MARK: - Helpers

    private static func statAt(_ path: String) throws -> (Bool, Double, Double) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            throw FsFailure.code("ENOENT", .notFound, "no such file or directory")
        }
        let attrs = try wrapErrno { try FileManager.default.attributesOfItem(atPath: path) }
        let size = (attrs[.size] as? NSNumber)?.doubleValue ?? 0
        let mtime =
            ((attrs[.modificationDate] as? Date).map { $0.timeIntervalSince1970 * 1000 } ?? 0)
            .rounded()
        return (isDirectory.boolValue, size, mtime)
    }

    /// Map Cocoa/POSIX errors to the shared `{ code, message }` failure shape.
    private static func wrapErrno<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch let failure as FsFailure {
            throw failure
        } catch {
            let ns = error as NSError
            let posix =
                (ns.userInfo[NSUnderlyingErrorKey] as? NSError).flatMap {
                    $0.domain == NSPOSIXErrorDomain ? $0.code : nil
                } ?? (ns.domain == NSPOSIXErrorDomain ? ns.code : nil)
            switch posix.map({ Int32($0) }) {
            case .some(ENOENT):
                throw FsFailure.code("ENOENT", .notFound, ns.localizedDescription)
            case .some(EACCES), .some(EPERM):
                throw FsFailure.code("EACCES", .forbidden, ns.localizedDescription)
            case .some(EISDIR):
                throw FsFailure.code("EISDIR", .conflict, ns.localizedDescription)
            case .some(ENOTDIR):
                throw FsFailure.code("ENOTDIR", .conflict, ns.localizedDescription)
            case .some(ENOTEMPTY):
                throw FsFailure.code("ENOTEMPTY", .conflict, ns.localizedDescription)
            case .some(EEXIST):
                throw FsFailure.code("EEXIST", .conflict, ns.localizedDescription)
            default:
                // Cocoa file-not-found without a POSIX underlying error.
                if ns.domain == NSCocoaErrorDomain
                    && (ns.code == NSFileReadNoSuchFileError || ns.code == NSFileNoSuchFileError)
                {
                    throw FsFailure.code("ENOENT", .notFound, ns.localizedDescription)
                }
                throw FsFailure.code("EIO", .internalServerError, ns.localizedDescription)
            }
        }
    }

    private static func run(_ body: () throws -> Response) throws -> Response {
        do {
            return try body()
        } catch let FsFailure.code(code, status, message) {
            return fsError(code, status, message)
        }
    }

    private static func fsError(_ code: String, _ status: HTTPResponse.Status, _ message: String)
        -> Response
    {
        let payload: LickSystem.JSONValue = .object([
            "code": .string(code), "message": .string(message),
        ])
        guard let data = try? JSONEncoder().encode(payload) else {
            return Response(status: status)
        }
        var headers = HTTPFields()
        headers[.contentType] = "application/json; charset=utf-8"
        return Response(status: status, headers: headers, body: .init(byteBuffer: ByteBuffer(bytes: data)))
    }

    private static func jsonBody(_ value: LickSystem.JSONValue) throws -> Response {
        let data = try JSONEncoder().encode(value)
        var headers = HTTPFields()
        headers[.contentType] = "application/json; charset=utf-8"
        return Response(status: .ok, headers: headers, body: .init(byteBuffer: ByteBuffer(bytes: data)))
    }
}
