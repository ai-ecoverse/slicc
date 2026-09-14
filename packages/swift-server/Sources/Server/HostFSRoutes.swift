import Foundation
import HTTPTypes
import Hummingbird
import NIOCore
































enum HostFSRoutes {
    
    static let maxBodyBytes = 100 * 1024 * 1024

    
    
    static let stableMaxBodyBytes = 1024 * 1024

    struct MountRoot: Sendable, Equatable {
        
        let path: String
        
        let root: String
    }

    
    
    
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

    

    
    
    static var rangeHeader: HTTPField.Name { HTTPField.Name("Range")! }
    static var contentRangeHeader: HTTPField.Name { HTTPField.Name("Content-Range")! }
    static var acceptRangesHeader: HTTPField.Name { HTTPField.Name("Accept-Ranges")! }

    
    
    
    enum ByteRange: Equatable {
        case whole
        case window(start: Int, end: Int)
        case unsatisfiable
    }

    
    
    
    
    
    
    
    
    
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
            
            guard let suffix = Int(rawEnd), suffix > 0 else { return .unsatisfiable }
            return .window(start: max(0, size - suffix), end: size - 1)
        }
        guard let start = Int(rawStart), start < size else { return .unsatisfiable }
        
        let end = rawEnd.isEmpty ? size - 1 : min(Int(rawEnd) ?? (size - 1), size - 1)
        guard end >= start else { return .unsatisfiable }
        return .window(start: start, end: end)
    }

    
    private static func readWindow(path: String, start: Int, length: Int) throws -> Data {
        try wrapErrno {
            let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(start))
            return try handle.read(upToCount: length) ?? Data()
        }
    }

    

    static var etagHeader: HTTPField.Name { HTTPField.Name("ETag")! }
    static var lastModifiedHeader: HTTPField.Name { HTTPField.Name("Last-Modified")! }
    static var ifNoneMatchHeader: HTTPField.Name { HTTPField.Name("If-None-Match")! }
    static var ifModifiedSinceHeader: HTTPField.Name { HTTPField.Name("If-Modified-Since")! }
    static var ifRangeHeader: HTTPField.Name { HTTPField.Name("If-Range")! }

    
    static let httpDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return formatter
    }()

    
    
    
    
    
    
    
    
    
    
    struct CacheValidator: Equatable {
        let etag: String
        let lastModified: String
        
        let mtimeSeconds: Int
    }

    static func cacheValidator(path: String, size: Int, mtimeMs: Double) -> CacheValidator {
        var info = stat()
        let ino = stat(path, &info) == 0 ? UInt64(info.st_ino) : 0
        let mtimeSeconds = Int((mtimeMs / 1000).rounded(.down))
        
        
        let mtimeMicros = UInt64(max(0, (mtimeMs * 1000).rounded(.down)))
        return CacheValidator(
            etag: "\"\(String(size, radix: 16))-\(String(mtimeMicros, radix: 16))"
                + "-\(String(ino, radix: 16))\"",
            lastModified: httpDateFormatter.string(
                from: Date(timeIntervalSince1970: Double(mtimeSeconds))),
            mtimeSeconds: mtimeSeconds)
    }

    
    private static func stripWeak(_ tag: String) -> String {
        tag.hasPrefix("W/") ? String(tag.dropFirst(2)) : tag
    }

    
    
    
    
    
    
    static func isNotModified(_ headers: HTTPFields, _ validator: CacheValidator) -> Bool {
        if let ifNoneMatch = headers[ifNoneMatchHeader] {
            let trimmed = ifNoneMatch.trimmingCharacters(in: .whitespaces)
            if trimmed == "*" { return true }
            return trimmed.split(separator: ",").contains {
                stripWeak($0.trimmingCharacters(in: .whitespaces)) == stripWeak(validator.etag)
            }
        }
        guard let ifModifiedSince = headers[ifModifiedSinceHeader] else { return false }
        
        guard let since = httpDateFormatter.date(from: ifModifiedSince) else { return false }
        return Double(validator.mtimeSeconds) <= since.timeIntervalSince1970
    }

    
    
    
    
    
    static func ifRangeAllowsRange(_ headers: HTTPFields, _ validator: CacheValidator) -> Bool {
        guard let ifRange = headers[ifRangeHeader] else { return true }
        let value = ifRange.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("\"") || value.hasPrefix("W/") { return value == validator.etag }
        guard let asDate = httpDateFormatter.date(from: value) else { return false }
        return Double(validator.mtimeSeconds) == asDate.timeIntervalSince1970
    }

    

    
    static let streamChunkBytes = 1024 * 1024

    
    
    
    
    
    
    
    
    
    
    
    private static func streamedFileBody(path: String, start: Int, length: Int) throws
        -> ResponseBody
    {
        
        
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

        
        
        
        
        router.post("/api/hostfs") { request, _ in
            
            
            
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

    

    private static func listResponse(_ dir: String) throws -> Response {
        let names = try wrapErrno { try FileManager.default.contentsOfDirectory(atPath: dir) }
        let entries: [LickSystem.JSONValue] = names.map { name in
            let full = dir + "/" + name
            var isDirectory: ObjCBool = false
            
            
            
            
            let resolves = FileManager.default.fileExists(atPath: full, isDirectory: &isDirectory)
            if resolves && isDirectory.boolValue {
                return .object(["name": .string(name), "kind": .string("directory")])
            }
            
            
            
            
            
            
            
            
            
            
            
            
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

    
    
    
    private static func readResponse(_ path: String, _ requestHeaders: HTTPFields) throws
        -> Response
    {
        let (isDirectory, rawSize, mtimeMs) = try statAt(path)
        if isDirectory {
            throw FsFailure.code("EISDIR", .conflict, "is a directory")
        }
        let size = Int(rawSize)
        let validator = cacheValidator(path: path, size: size, mtimeMs: mtimeMs)
        
        
        var headers = HTTPFields()
        headers[acceptRangesHeader] = "bytes"
        headers[etagHeader] = validator.etag
        headers[lastModifiedHeader] = validator.lastModified
        if isNotModified(requestHeaders, validator) {
            
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
        
        
        let mtime = (attrs[.modificationDate] as? Date).map { $0.timeIntervalSince1970 * 1000 } ?? 0
        return (isDirectory.boolValue, size, mtime)
    }

    
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
