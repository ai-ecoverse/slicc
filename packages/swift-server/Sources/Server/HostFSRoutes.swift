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
///
/// Two request shapes reach the same op implementations: the per-op routes
/// (`GET /api/hostfs/list?mount=&path=` …) and a single stable
/// `POST /api/hostfs` whose JSON body carries `{ op, mount, path, … }`. The
/// stable endpoint exists purely so CORS preflights are cacheable: the
/// preflight cache is keyed by URL, and the per-op URLs are unique per path,
/// so `Access-Control-Max-Age` never applied (#2715). `read` and `write` keep
/// their per-op routes — a POST response is not cacheable, and a read the
/// browser can revalidate with a 304 is worth more than its preflight.
///
/// `read` also speaks `Range` (single `bytes=` window, 206 + `Content-Range`,
/// 416 outside the file). Without it a repo whose largest packfile crosses
/// `maxBodyBytes` is unreadable by git, because isomorphic-git needs the pack
/// as one buffer and the bridge refused to serve it (issue #2711). The
/// whole-file cap still guards an unranged read; a ranged read is bounded by
/// the window it names, so it is exempt — and every body is STREAMED in
/// `streamChunkBytes` pieces, so lifting the cap did not hand a `bytes=0-` on
/// a multi-GB file a way to allocate it whole. `ETag`/`Last-Modified` come
/// from the stat and `If-None-Match`/`If-Modified-Since`/`If-Range` are
/// honored, matching `cacheValidator` in `hostfs.ts`: without a validator the
/// browser re-transfers a 92 MB pack on every object lookup.
enum HostFSRoutes {
    /// Matches the webapp's hostfs body cap (`backend-hostfs.ts`).
    static let maxBodyBytes = 100 * 1024 * 1024

    /// Bounded cap for the stable dispatcher — it only ever carries a small
    /// JSON envelope. Mirrors node-server's `HOSTFS_STABLE_MAX_BODY_BYTES`.
    static let stableMaxBodyBytes = 1024 * 1024

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

    // MARK: - Byte ranges

    /// Header names built by string so the code does not depend on which
    /// standard names this swift-http-types version happens to expose.
    static var rangeHeader: HTTPField.Name { HTTPField.Name("Range")! }
    static var contentRangeHeader: HTTPField.Name { HTTPField.Name("Content-Range")! }
    static var acceptRangesHeader: HTTPField.Name { HTTPField.Name("Accept-Ranges")! }

    /// What `Range:` asked for, resolved against the file's actual size.
    /// `window` is INCLUSIVE on both ends, exactly as `Content-Range` wants it.
    /// Mirrors node-server's `ParsedByteRange`.
    enum ByteRange: Equatable {
        case whole
        case window(start: Int, end: Int)
        case unsatisfiable
    }

    /// Parse a single-range `Range: bytes=…` header against a known file size.
    ///
    /// Deliberately narrow: one range, `bytes` unit only. RFC 9110 §14.2 says
    /// a recipient that cannot make sense of a Range header MUST ignore it, so
    /// anything malformed falls back to `whole`. Only a well-formed range
    /// outside the file is a 416 — answering that one with the whole file
    /// would hand the caller bytes from offsets it never asked for, which a
    /// pack reader would parse as garbage. Mirrors node-server's
    /// `parseByteRange`.
    static func parseByteRange(_ header: String?, size: Int) -> ByteRange {
        guard let header else { return .whole }
        let trimmed = header.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("bytes=") else { return .whole }
        let spec = trimmed.dropFirst("bytes=".count)
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return .whole }
        let rawStart = String(parts[0])
        let rawEnd = String(parts[1])
        guard rawStart.allSatisfy(\.isNumber), rawEnd.allSatisfy(\.isNumber) else { return .whole }
        if rawStart.isEmpty && rawEnd.isEmpty { return .whole }
        if size == 0 { return .unsatisfiable }

        if rawStart.isEmpty {
            // Suffix form `bytes=-N`: the last N bytes. `-0` names nothing.
            guard let suffix = Int(rawEnd), suffix > 0 else { return .unsatisfiable }
            return .window(start: max(0, size - suffix), end: size - 1)
        }
        guard let start = Int(rawStart), start < size else { return .unsatisfiable }
        // An open-ended `bytes=N-` runs to EOF; an explicit end past EOF clamps.
        let end = rawEnd.isEmpty ? size - 1 : min(Int(rawEnd) ?? (size - 1), size - 1)
        guard end >= start else { return .unsatisfiable }
        return .window(start: start, end: end)
    }

    /// Read `length` bytes from `start` without materializing the whole file.
    private static func readWindow(path: String, start: Int, length: Int) throws -> Data {
        try wrapErrno {
            let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(start))
            return try handle.read(upToCount: length) ?? Data()
        }
    }

    // MARK: - Cache validators

    static var etagHeader: HTTPField.Name { HTTPField.Name("ETag")! }
    static var lastModifiedHeader: HTTPField.Name { HTTPField.Name("Last-Modified")! }
    static var ifNoneMatchHeader: HTTPField.Name { HTTPField.Name("If-None-Match")! }
    static var ifModifiedSinceHeader: HTTPField.Name { HTTPField.Name("If-Modified-Since")! }
    static var ifRangeHeader: HTTPField.Name { HTTPField.Name("If-Range")! }

    /// IMF-fixdate, the only `HTTP-date` form anything still emits.
    static let httpDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return formatter
    }()

    /// Cache validators for one file, derived from its `stat`. Mirrors
    /// node-server's `cacheValidator`.
    ///
    /// The ETag is STRONG (no `W/`) on purpose: `If-Range` is only defined for
    /// a strong validator, and a ranged pack read is the case that matters most
    /// here. What justifies "strong" is what goes into it — inode, size and an
    /// unrounded high-resolution mtime. The honest limit: a write landing on
    /// the same inode with an identical size AND a deliberately restored mtime
    /// is invisible to it. Nothing git does looks like that, and the
    /// alternative is hashing the body, which is the buffering we removed.
    struct CacheValidator: Equatable {
        let etag: String
        let lastModified: String
        /// mtime floored to the second, which is all an HTTP-date can carry.
        let mtimeSeconds: Int
    }

    static func cacheValidator(path: String, size: Int, mtimeMs: Double) -> CacheValidator {
        var info = stat()
        let ino = stat(path, &info) == 0 ? UInt64(info.st_ino) : 0
        let mtimeSeconds = Int((mtimeMs / 1000).rounded(.down))
        // Hex, and mtime scaled to whole microseconds so the token is an
        // integer rather than a locale-free float rendering.
        let mtimeMicros = UInt64(max(0, (mtimeMs * 1000).rounded(.down)))
        return CacheValidator(
            etag: "\"\(String(size, radix: 16))-\(String(mtimeMicros, radix: 16))"
                + "-\(String(ino, radix: 16))\"",
            lastModified: httpDateFormatter.string(
                from: Date(timeIntervalSince1970: Double(mtimeSeconds))),
            mtimeSeconds: mtimeSeconds)
    }

    /// Drop a `W/` prefix so the weak comparison treats `W/"x"` and `"x"` alike.
    private static func stripWeak(_ tag: String) -> String {
        tag.hasPrefix("W/") ? String(tag.dropFirst(2)) : tag
    }

    /// True when the client already holds this exact representation → 304.
    ///
    /// RFC 9110 §13.2.1 fixes the precedence: `If-None-Match` decides on its
    /// own whenever present, and `If-Modified-Since` is consulted only in its
    /// absence. `If-None-Match` uses the WEAK comparison, so a cached weak form
    /// of our tag still matches. Mirrors node-server's `isNotModified`.
    static func isNotModified(_ headers: HTTPFields, _ validator: CacheValidator) -> Bool {
        if let ifNoneMatch = headers[ifNoneMatchHeader] {
            let trimmed = ifNoneMatch.trimmingCharacters(in: .whitespaces)
            if trimmed == "*" { return true }
            return trimmed.split(separator: ",").contains {
                stripWeak($0.trimmingCharacters(in: .whitespaces)) == stripWeak(validator.etag)
            }
        }
        guard let ifModifiedSince = headers[ifModifiedSinceHeader] else { return false }
        // An unparseable date is not a claim about anything — serve the file.
        guard let since = httpDateFormatter.date(from: ifModifiedSince) else { return false }
        return Double(validator.mtimeSeconds) <= since.timeIntervalSince1970
    }

    /// Whether a `Range` may still be honored. A mismatched `If-Range`
    /// downgrades to a plain 200 rather than erroring, which is what stops a
    /// client stitching a window of the NEW file into a buffer holding the old
    /// one. Comparison is STRONG (RFC 9110 §13.1.5). Mirrors node-server's
    /// `ifRangeAllowsRange`.
    static func ifRangeAllowsRange(_ headers: HTTPFields, _ validator: CacheValidator) -> Bool {
        guard let ifRange = headers[ifRangeHeader] else { return true }
        let value = ifRange.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("\"") || value.hasPrefix("W/") { return value == validator.etag }
        guard let asDate = httpDateFormatter.date(from: value) else { return false }
        return Double(validator.mtimeSeconds) == asDate.timeIntervalSince1970
    }

    // MARK: - Streaming

    /// How much of a file is held in memory at once while streaming it out.
    static let streamChunkBytes = 1024 * 1024

    /// A body that reads `length` bytes from `start` in bounded chunks.
    ///
    /// The point of a ranged read is that a multi-GB pack becomes reachable, so
    /// materializing the window with `Data(contentsOf:)` before handing it to a
    /// `ByteBuffer` would have removed the 100 MiB guard without replacing it —
    /// an open-ended `bytes=0-` on a huge file would allocate the whole thing.
    /// Hummingbird's closure-backed `ResponseBody` lets the window go out a
    /// chunk at a time instead, matching what node-server's `createReadStream`
    /// does. A failure mid-body arrives after the status line is spent, so it
    /// propagates and drops the connection — the same truncated-body signal the
    /// client's retry path already handles.
    private static func streamedFileBody(path: String, start: Int, length: Int) throws
        -> ResponseBody
    {
        // Open eagerly so ENOENT/EACCES still becomes errno JSON, before any
        // header is on the wire.
        let handle = try wrapErrno {
            try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        }
        if start > 0 {
            try wrapErrno { try handle.seek(toOffset: UInt64(start)) }
        }
        return ResponseBody(contentLength: length) { writer in
            defer { try? handle.close() }
            var remaining = length
            while remaining > 0 {
                let want = min(remaining, streamChunkBytes)
                guard let chunk = try handle.read(upToCount: want), !chunk.isEmpty else { break }
                try await writer.write(ByteBuffer(bytes: chunk))
                remaining -= chunk.count
            }
            try await writer.finish(nil)
        }
    }

    // MARK: - Registration

    /// Body of the stable `POST /api/hostfs` endpoint. One URL for every
    /// metadata op so the CORS preflight cache (keyed by URL) can actually
    /// hold — the per-op routes put the path in the query string, so every
    /// request hit a fresh URL and `Access-Control-Max-Age` never applied
    /// (#2715). Mirrors node-server's dispatcher in `src/hostfs.ts`.
    struct StableRequestBody {
        let op: String
        let mount: String
        let path: String
        let to: String?
        let recursive: Bool

        init?(data: Data) {
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let op = object["op"] as? String
            else { return nil }
            self.op = op
            self.mount = object["mount"] as? String ?? ""
            self.path = object["path"] as? String ?? ""
            self.to = object["to"] as? String
            // `recursive` accepts the query-string "1" and a JSON true alike.
            if let flag = object["recursive"] as? Bool {
                self.recursive = flag
            } else if let flag = object["recursive"] as? String {
                self.recursive = flag == "1"
            } else {
                self.recursive = false
            }
        }
    }

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

        // Stable-URL dispatcher for the metadata ops. `read`/`write` keep
        // their per-op routes: a POST response is not cacheable, and a read
        // that the browser can revalidate with a 304 is worth far more than
        // its preflight.
        router.post("/api/hostfs") { request, _ in
            // Oversized and unparseable are distinct answers, and both must
            // carry an errno code — node-server's `hostFsBodyErrorHandler`
            // maps its body-parser failures to exactly these two.
            let buffer: ByteBuffer
            do {
                buffer = try await request.body.collect(upTo: stableMaxBodyBytes)
            } catch {
                return fsError("EFBIG", .contentTooLarge, "hostfs body exceeds the stable cap")
            }
            guard let body = StableRequestBody(data: Data(buffer: buffer)) else {
                return fsError("EINVAL", .badRequest, "hostfs body must be JSON carrying an op")
            }
            guard let entry = byPath[body.mount] else {
                return fsError("ENOENT", .notFound, "no such mount: \(body.mount)")
            }
            return try run {
                let path = try resolveWithinRoot(root: entry.root, relPath: body.path)
                return try dispatchStable(body, path: path, entry: entry, roots: roots)
            }
        }

        router.get("/api/hostfs/list") { request, _ in
            try run { try listResponse(try target(for: request)) }
        }

        router.get("/api/hostfs/stat") { request, _ in
            try run { try statResponse(try target(for: request)) }
        }

        router.get("/api/hostfs/read") { request, _ in
            try run { try readResponse(try target(for: request), request.headers) }
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
            try run { try mkdirResponse(try target(for: request)) }
        }

        router.post("/api/hostfs/rename") { request, _ in
            try run {
                try renameResponse(
                    from: try target(for: request), to: try target(for: request, pathParam: "to"))
            }
        }

        router.delete("/api/hostfs/remove") { request, _ in
            try run {
                let recursive = String(request.uri.queryParameters["recursive"] ?? "") == "1"
                return try removeResponse(
                    try target(for: request), recursive: recursive, roots: roots)
            }
        }
    }

    /// Route one decoded stable-endpoint body to the shared op implementation.
    /// Every failure carries an errno `code` — a code-less 404 is exactly how
    /// `HostFsMountBackend` detects a bridge without this route and downgrades
    /// to the per-op routes, so it must never leak from here.
    private static func dispatchStable(
        _ body: StableRequestBody, path: String, entry: MountRoot, roots: [MountRoot]
    ) throws -> Response {
        switch body.op {
        case "list": return try listResponse(path)
        case "stat": return try statResponse(path)
        case "mkdir": return try mkdirResponse(path)
        case "rename":
            guard let toRel = body.to, !toRel.isEmpty else {
                throw FsFailure.code("EINVAL", .badRequest, "rename requires to")
            }
            return try renameResponse(
                from: path, to: try resolveWithinRoot(root: entry.root, relPath: toRel))
        case "remove":
            return try removeResponse(path, recursive: body.recursive, roots: roots)
        default:
            throw FsFailure.code("EINVAL", .badRequest, "unsupported hostfs op: \(body.op)")
        }
    }

    // MARK: - Op implementations (shared by both request shapes)

    private static func listResponse(_ dir: String) throws -> Response {
        let names = try wrapErrno { try FileManager.default.contentsOfDirectory(atPath: dir) }
        let entries: [LickSystem.JSONValue] = names.map { name in
            let full = dir + "/" + name
            var isDirectory: ObjCBool = false
            // Follows symlinks, like node's `stat(resolve(target, d.name))`:
            // a link to a directory classifies as a directory, and a DANGLING
            // link (or an entry deleted since `contentsOfDirectory`) does not
            // resolve at all.
            let resolves = FileManager.default.fileExists(atPath: full, isDirectory: &isDirectory)
            if resolves && isDirectory.boolValue {
                return .object(["name": .string(name), "kind": .string("directory")])
            }
            // An entry we could not measure reports the NAME ONLY — never
            // `size: 0, lastModified: 0`, and never the dangling LINK's own
            // attributes (`attributesOfItem` does not follow links, so it
            // would happily describe a target that isn't there, for a path
            // whose `stat` op answers ENOENT).
            //
            // The webapp uses a listing's numbers in place of a stat (issue
            // #2716), where zeros are indistinguishable from a real empty
            // file at the epoch: isomorphic-git would call that file stale
            // forever and rewrite `.git/index` once per file (#2708), and
            // `ls -l` would print them. node-server's `listOp` omits them for
            // exactly this reason — the two bridges have to agree.
            guard resolves,
                let attrs = try? FileManager.default.attributesOfItem(atPath: full),
                let size = (attrs[.size] as? NSNumber)?.doubleValue,
                let mtime = (attrs[.modificationDate] as? Date).map({
                    $0.timeIntervalSince1970 * 1000
                })
            else {
                return .object(["name": .string(name), "kind": .string("file")])
            }
            var entry: [String: LickSystem.JSONValue] = [
                "name": .string(name),
                "kind": .string("file"),
                "size": .number(size),
                "lastModified": .number(mtime),
            ]
            entry.merge(statIdentity(full)) { current, _ in current }
            return .object(entry)
        }
        return try jsonBody(.object(["entries": .array(entries)]))
    }

    private static func statResponse(_ path: String) throws -> Response {
        let (isDirectory, size, mtime) = try statAt(path)
        var payload: [String: LickSystem.JSONValue] = [
            "kind": .string(isDirectory ? "directory" : "file"),
            "size": .number(isDirectory ? 0 : size),
            "mtime": .number(mtime),
        ]
        payload.merge(statIdentity(path)) { current, _ in current }
        return try jsonBody(.object(payload))
    }

    /// `GET /api/hostfs/read` — the whole file, the `Range` window it asked
    /// for, or `304` when the client already holds it. Mirrors node-server's
    /// `readOp`.
    private static func readResponse(_ path: String, _ requestHeaders: HTTPFields) throws
        -> Response
    {
        let (isDirectory, rawSize, mtimeMs) = try statAt(path)
        if isDirectory {
            throw FsFailure.code("EISDIR", .conflict, "is a directory")
        }
        let size = Int(rawSize)
        let validator = cacheValidator(path: path, size: size, mtimeMs: mtimeMs)
        // Every answer carries the validators, 304 included — that is how the
        // client refreshes its stored response metadata.
        var headers = HTTPFields()
        headers[acceptRangesHeader] = "bytes"
        headers[etagHeader] = validator.etag
        headers[lastModifiedHeader] = validator.lastModified
        if isNotModified(requestHeaders, validator) {
            // 304 MUST NOT carry a body.
            return Response(status: .notModified, headers: headers)
        }
        let validatorHeaders: [(HTTPField.Name, String)] = [
            (acceptRangesHeader, "bytes"), (etagHeader, validator.etag),
            (lastModifiedHeader, validator.lastModified),
        ]
        let range =
            ifRangeAllowsRange(requestHeaders, validator)
            ? parseByteRange(requestHeaders[rangeHeader], size: size) : .whole
        switch range {
        case .unsatisfiable:
            return fsError(
                "EINVAL", .rangeNotSatisfiable, "range not satisfiable for a \(size) byte file",
                extra: validatorHeaders + [(contentRangeHeader, "bytes */\(size)")])
        case .window(let start, let end):
            // No size cap here on purpose: the window IS the bound, and the
            // body is STREAMED, so neither side ever holds more than
            // `streamChunkBytes`. That is what lets git reach a pack larger
            // than `maxBodyBytes` at all (issue #2711).
            headers[.contentType] = "application/octet-stream"
            headers[contentRangeHeader] = "bytes \(start)-\(end)/\(size)"
            return Response(
                status: .partialContent, headers: headers,
                body: try streamedFileBody(path: path, start: start, length: end - start + 1))
        case .whole:
            if size > maxBodyBytes {
                return fsError(
                    "EFBIG", .contentTooLarge,
                    "file exceeds the hostfs whole-file cap; read it with a Range request",
                    extra: validatorHeaders)
            }
            headers[.contentType] = "application/octet-stream"
            return Response(
                status: .ok, headers: headers,
                body: try streamedFileBody(path: path, start: 0, length: size))
        }
    }

    private static func mkdirResponse(_ path: String) throws -> Response {
        try wrapErrno {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        }
        return try jsonBody(.object(["ok": .bool(true)]))
    }

    private static func renameResponse(from: String, to: String) throws -> Response {
        try wrapErrno { try FileManager.default.moveItem(atPath: from, toPath: to) }
        return try jsonBody(.object(["ok": .bool(true)]))
    }

    private static func removeResponse(_ path: String, recursive: Bool, roots: [MountRoot]) throws
        -> Response
    {
        if roots.contains(where: { $0.root == path }) {
            throw FsFailure.code("EACCES", .forbidden, "refusing to remove a mount root")
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            throw FsFailure.code("ENOENT", .notFound, "no such file or directory")
        }
        if isDirectory.boolValue && !recursive {
            let contents = (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
            if !contents.isEmpty {
                throw FsFailure.code("ENOTEMPTY", .conflict, "directory not empty")
            }
        }
        try wrapErrno { try FileManager.default.removeItem(atPath: path) }
        return try jsonBody(.object(["ok": .bool(true)]))
    }

    // MARK: - Helpers

    /// Identity/permission fields of a host `stat(2)`, mirroring node-server's
    /// `statIdentity` in `src/hostfs.ts`.
    ///
    /// isomorphic-git's `compareStats` decides that a working-tree file still
    /// matches its index entry by comparing mode, mtime, ctime, uid, gid, ino
    /// and size. The bridge used to report only `{kind,size,mtime}`, so the
    /// comparison was stale for EVERY file and every read-only git command
    /// re-hashed the tree and rewrote `.git/index` once per file (issue
    /// #2708). `mode` is the full `st_mode` (type bits included), so the
    /// executable bit survives instead of being flattened to `100644`.
    ///
    /// Goes through `stat(2)` rather than `FileManager.attributesOfItem`
    /// because Foundation exposes `.creationDate` (birth time), not the POSIX
    /// inode-change time git actually records. A failed stat yields an empty
    /// dictionary — the webapp then keeps its synthesized defaults.
    ///
    /// Timestamps go over the wire UNROUNDED. isomorphic-git derives the
    /// seconds it compares with `Math.floor(ms / 1000)`, so rounding a
    /// `.9996 s` stat up lands it in the NEXT second, disagrees with the
    /// seconds native git wrote, and makes that one file stale on every walk.
    private static func statIdentity(_ path: String) -> [String: LickSystem.JSONValue] {
        var info = stat()
        guard stat(path, &info) == 0 else { return [:] }
        #if canImport(Darwin)
            let ctimespec = info.st_ctimespec
        #else
            let ctimespec = info.st_ctim
        #endif
        let ctimeMs = Double(ctimespec.tv_sec) * 1000 + Double(ctimespec.tv_nsec) / 1_000_000
        return [
            "ctime": .number(ctimeMs),
            "ino": .number(Double(info.st_ino)),
            "uid": .number(Double(info.st_uid)),
            "gid": .number(Double(info.st_gid)),
            "mode": .number(Double(info.st_mode)),
        ]
    }

    private static func statAt(_ path: String) throws -> (Bool, Double, Double) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            throw FsFailure.code("ENOENT", .notFound, "no such file or directory")
        }
        let attrs = try wrapErrno { try FileManager.default.attributesOfItem(atPath: path) }
        let size = (attrs[.size] as? NSNumber)?.doubleValue ?? 0
        // Unrounded — see `statIdentity` on why a rounded-up millisecond
        // makes a file permanently stale against the git index.
        let mtime = (attrs[.modificationDate] as? Date).map { $0.timeIntervalSince1970 * 1000 } ?? 0
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

    /// `extra` carries the headers an errno answer still has to advertise —
    /// a 416 owes the client a `Content-Range: bytes */<size>` (RFC 9110 §15.5.17).
    private static func fsError(
        _ code: String, _ status: HTTPResponse.Status, _ message: String,
        extra: [(HTTPField.Name, String)] = []
    )
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
        for (name, value) in extra { headers[name] = value }
        return Response(status: status, headers: headers, body: .init(byteBuffer: ByteBuffer(bytes: data)))
    }

    private static func jsonBody(_ value: LickSystem.JSONValue) throws -> Response {
        let data = try JSONEncoder().encode(value)
        var headers = HTTPFields()
        headers[.contentType] = "application/json; charset=utf-8"
        return Response(status: .ok, headers: headers, body: .init(byteBuffer: ByteBuffer(bytes: data)))
    }
}
