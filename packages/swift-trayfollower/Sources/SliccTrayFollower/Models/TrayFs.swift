import Foundation

// Wire types for the tray `fs.*` protocol, mirroring `TrayFsRequest`,
// `TrayFsResponse` and `TrayFsResponseData` in
// `packages/shared-ts/src/tray-sync-protocol.ts`.
//
// The direction matters and is easy to get backwards: iOS is the *requester*.
// A `fs.request` carrying `targetRuntimeId: "leader"` is routed by
// `follower-dispatch.ts` to `FsRouter.executeLocalFs`, which runs it against
// the leader's VFS and replies. This is the phone reading the leader's
// filesystem, not the leader reaching into the phone.
//
// Every op in the TS union is mirrored here so the corpus round-trips the
// whole surface. `FsClient` exposes only the read ops today; see its notes.

// MARK: - Request

/// Text encoding for a read. `binary` asks the leader to base64 the bytes.
public enum TrayFsReadEncoding: String, Codable {
    case utf8 = "utf-8"
    case binary
}

/// Encoding of the `content` field on a write.
public enum TrayFsWriteEncoding: String, Codable {
    case utf8 = "utf-8"
    case base64
}

/// A single FS operation, discriminated by `op`.
public enum TrayFsRequest: Codable, Equatable {
    case readFile(path: String, encoding: TrayFsReadEncoding?)
    case writeFile(path: String, content: String, encoding: TrayFsWriteEncoding)
    case stat(path: String)
    case readDir(path: String)
    case mkdir(path: String, recursive: Bool?)
    case rm(path: String, recursive: Bool?)
    case exists(path: String)
    case walk(path: String)

    private enum CodingKeys: String, CodingKey {
        case op, path, content, encoding, recursive
    }

    /// The `op` discriminator as it appears on the wire.
    public var op: String {
        switch self {
        case .readFile: return "readFile"
        case .writeFile: return "writeFile"
        case .stat: return "stat"
        case .readDir: return "readDir"
        case .mkdir: return "mkdir"
        case .rm: return "rm"
        case .exists: return "exists"
        case .walk: return "walk"
        }
    }

    /// The target path, common to every op.
    public var path: String {
        switch self {
        case .readFile(let path, _),
            .writeFile(let path, _, _),
            .stat(let path),
            .readDir(let path),
            .mkdir(let path, _),
            .rm(let path, _),
            .exists(let path),
            .walk(let path):
            return path
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let op = try container.decode(String.self, forKey: .op)
        let path = try container.decode(String.self, forKey: .path)
        switch op {
        case "readFile":
            self = .readFile(
                path: path,
                encoding: try container.decodeIfPresent(TrayFsReadEncoding.self, forKey: .encoding))
        case "writeFile":
            self = .writeFile(
                path: path,
                content: try container.decode(String.self, forKey: .content),
                encoding: try container.decode(TrayFsWriteEncoding.self, forKey: .encoding))
        case "stat":
            self = .stat(path: path)
        case "readDir":
            self = .readDir(path: path)
        case "mkdir":
            self = .mkdir(
                path: path,
                recursive: try container.decodeIfPresent(Bool.self, forKey: .recursive))
        case "rm":
            self = .rm(
                path: path,
                recursive: try container.decodeIfPresent(Bool.self, forKey: .recursive))
        case "exists":
            self = .exists(path: path)
        case "walk":
            self = .walk(path: path)
        default:
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unknown fs op: \(op)"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(op, forKey: .op)
        try container.encode(path, forKey: .path)
        switch self {
        case .readFile(_, let encoding):
            try container.encodeIfPresent(encoding, forKey: .encoding)
        case .writeFile(_, let content, let encoding):
            try container.encode(content, forKey: .content)
            try container.encode(encoding, forKey: .encoding)
        case .mkdir(_, let recursive), .rm(_, let recursive):
            try container.encodeIfPresent(recursive, forKey: .recursive)
        case .stat, .readDir, .exists, .walk:
            break
        }
    }
}

// MARK: - Response payloads

/// One entry from a `readDir`, or one node type from a `stat`.
public enum TrayFsNodeType: String, Codable {
    case file
    case directory
    case symlink
}

public struct TrayFsStat: Codable, Equatable {
    public let type: TrayFsNodeType
    public let size: Int
    public let mtime: Double
    public let ctime: Double

    public init(type: TrayFsNodeType, size: Int, mtime: Double, ctime: Double) {
        self.type = type
        self.size = size
        self.mtime = mtime
        self.ctime = ctime
    }
}

public struct TrayFsDirEntry: Codable, Equatable {
    public let name: String
    public let type: TrayFsNodeType

    public init(name: String, type: TrayFsNodeType) {
        self.name = name
        self.type = type
    }
}

/// The `data` payload of a successful response, discriminated by `type`.
public enum TrayFsResponseData: Codable, Equatable {
    case file(content: String, encoding: TrayFsWriteEncoding)
    case stat(TrayFsStat)
    case dirEntries([TrayFsDirEntry])
    case exists(Bool)
    case paths([String])
    case void

    private enum CodingKeys: String, CodingKey {
        case type, content, encoding, stat, entries, exists, paths
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "file":
            self = .file(
                content: try container.decode(String.self, forKey: .content),
                encoding: try container.decode(TrayFsWriteEncoding.self, forKey: .encoding))
        case "stat":
            self = .stat(try container.decode(TrayFsStat.self, forKey: .stat))
        case "dirEntries":
            self = .dirEntries(try container.decode([TrayFsDirEntry].self, forKey: .entries))
        case "exists":
            self = .exists(try container.decode(Bool.self, forKey: .exists))
        case "paths":
            self = .paths(try container.decode([String].self, forKey: .paths))
        case "void":
            self = .void
        default:
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unknown fs response data type: \(type)"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .file(let content, let encoding):
            try container.encode("file", forKey: .type)
            try container.encode(content, forKey: .content)
            try container.encode(encoding, forKey: .encoding)
        case .stat(let stat):
            try container.encode("stat", forKey: .type)
            try container.encode(stat, forKey: .stat)
        case .dirEntries(let entries):
            try container.encode("dirEntries", forKey: .type)
            try container.encode(entries, forKey: .entries)
        case .exists(let exists):
            try container.encode("exists", forKey: .type)
            try container.encode(exists, forKey: .exists)
        case .paths(let paths):
            try container.encode("paths", forKey: .type)
            try container.encode(paths, forKey: .paths)
        case .void:
            try container.encode("void", forKey: .type)
        }
    }
}

// MARK: - Response envelope

/// A single FS response. `ok` discriminates: success carries `data` (and, for
/// a chunked file read, `chunkIndex`/`totalChunks`), failure carries `error`
/// and an optional errno-style `code`.
public struct TrayFsResponse: Codable, Equatable {
    public let ok: Bool
    public let data: TrayFsResponseData?
    public let error: String?
    public let code: String?
    public let chunkIndex: Int?
    public let totalChunks: Int?

    public init(
        ok: Bool,
        data: TrayFsResponseData? = nil,
        error: String? = nil,
        code: String? = nil,
        chunkIndex: Int? = nil,
        totalChunks: Int? = nil
    ) {
        self.ok = ok
        self.data = data
        self.error = error
        self.code = code
        self.chunkIndex = chunkIndex
        self.totalChunks = totalChunks
    }

    // Public because a production consumer (`SliccTrayKit/Sync/FsClient.swift`)
    // constructs refusals through these once this type lives in a separate
    // module — `@testable` reaches internal statics only from test builds.
    public static func success(_ data: TrayFsResponseData) -> TrayFsResponse {
        TrayFsResponse(ok: true, data: data)
    }

    public static func failure(_ error: String, code: String? = nil) -> TrayFsResponse {
        TrayFsResponse(ok: false, error: error, code: code)
    }
}
