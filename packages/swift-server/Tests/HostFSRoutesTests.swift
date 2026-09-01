import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import NIOCore
import XCTest

@testable import slicc_server

/// The /api/hostfs surface must behave byte-for-byte like node-server's
/// `hostfs.ts` — the webapp's `HostFsMountBackend` speaks to both.
final class HostFSRoutesTests: XCTestCase {
    private var root = ""
    private var outside = ""

    override func setUpWithError() throws {
        root = NSTemporaryDirectory() + "slicc-hostfs-" + UUID().uuidString
        outside = NSTemporaryDirectory() + "slicc-hostfs-outside-" + UUID().uuidString
        try FileManager.default.createDirectory(
            atPath: root + "/sub", withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            atPath: outside, withIntermediateDirectories: true)
        try Data("hello host".utf8).write(to: URL(fileURLWithPath: root + "/hello.txt"))
        try Data("nope".utf8).write(to: URL(fileURLWithPath: outside + "/secret.txt"))
        try FileManager.default.createSymbolicLink(
            atPath: root + "/escape-link", withDestinationPath: outside)
        // The registered root is symlink-resolved; keep the same view here.
        root = URL(fileURLWithPath: root).resolvingSymlinksInPath().path
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: root)
        try? FileManager.default.removeItem(atPath: outside)
    }

    private func makeApp() -> Application<RouterResponder<BasicRequestContext>> {
        let router = Router()
        let roots = HostFSRoutes.resolveRoots(
            mounts: [
                ServerConfig.MountMapping(hostPath: root, path: "/mnt/proj"),
                ServerConfig.MountMapping(hostPath: root + "/does-not-exist", path: "/mnt/gone"),
            ],
            warn: { _ in }
        )
        XCTAssertEqual(roots.map(\.path), ["/mnt/proj"])
        HostFSRoutes.registerRoutes(router: router, roots: roots)
        return Application(responder: router.buildResponder())
    }

    private func decode(_ body: ByteBuffer) throws -> LickSystem.JSONValue {
        var buffer = body
        let data = buffer.readData(length: buffer.readableBytes) ?? Data()
        return try JSONDecoder().decode(LickSystem.JSONValue.self, from: data)
    }

    func testListStatReadRoundTrip() async throws {
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/list?mount=%2Fmnt%2Fproj&path=", method: .get
            ) { response in
                XCTAssertEqual(response.status, .ok)
                guard case .object(let body) = try self.decode(response.body),
                    case .array(let entries)? = body["entries"]
                else { return XCTFail("bad list shape") }
                let names = entries.compactMap { entry -> String? in
                    guard case .object(let e) = entry, case .string(let name)? = e["name"] else {
                        return nil
                    }
                    return name
                }
                XCTAssertEqual(names.sorted(), ["escape-link", "hello.txt", "sub"])
            }
            try await client.execute(
                uri: "/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=hello.txt", method: .get
            ) { response in
                XCTAssertEqual(response.status, .ok)
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad stat shape")
                }
                XCTAssertEqual(body["kind"], .string("file"))
                XCTAssertEqual(body["size"], .number(10))
            }
            try await client.execute(
                uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt", method: .get
            ) { response in
                XCTAssertEqual(response.status, .ok)
                var buffer = response.body
                let data = buffer.readData(length: buffer.readableBytes) ?? Data()
                XCTAssertEqual(String(decoding: data, as: UTF8.self), "hello host")
            }
        }
    }

    /// The webapp needs ctime/ino/uid/gid/mode to decide a working-tree file
    /// still matches its git index entry; without them every read-only git
    /// command rewrites `.git/index` once per file (issue #2708). Mirrors
    /// node-server's `statIdentity`.
    func testStatReportsIdentityFieldsForCompareStats() async throws {
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: root + "/hello.txt")
        var info = stat()
        XCTAssertEqual(stat(root + "/hello.txt", &info), 0)
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=hello.txt", method: .get
            ) { response in
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad stat shape")
                }
                XCTAssertEqual(body["ino"], .number(Double(info.st_ino)))
                XCTAssertEqual(body["uid"], .number(Double(info.st_uid)))
                XCTAssertEqual(body["gid"], .number(Double(info.st_gid)))
                // Full st_mode, so the executable bit survives instead of
                // being flattened to 100644.
                XCTAssertEqual(body["mode"], .number(Double(info.st_mode)))
                guard case .number(let mode)? = body["mode"] else { return XCTFail("no mode") }
                XCTAssertEqual(mode_t(mode) & 0o777, 0o755)
                // Unrounded: rounding a .9996 s stat up would push it into
                // the next second and leave the file permanently stale.
                let ctimeMs =
                    Double(info.st_ctimespec.tv_sec) * 1000
                    + Double(info.st_ctimespec.tv_nsec) / 1_000_000
                XCTAssertEqual(body["ctime"], .number(ctimeMs))
            }
            try await client.execute(
                uri: "/api/hostfs/list?mount=%2Fmnt%2Fproj&path=", method: .get
            ) { response in
                guard case .object(let body) = try self.decode(response.body),
                    case .array(let entries)? = body["entries"]
                else { return XCTFail("bad list shape") }
                let hello = entries.first { entry in
                    guard case .object(let e) = entry, case .string("hello.txt")? = e["name"]
                    else { return false }
                    return true
                }
                guard case .object(let e)? = hello else { return XCTFail("no hello.txt entry") }
                XCTAssertEqual(e["ino"], .number(Double(info.st_ino)))
                XCTAssertEqual(e["mode"], .number(Double(info.st_mode)))
            }
            // The stable dispatcher shares `statResponse`, so a webapp on the
            // preflight-cacheable transport must see the same enriched payload.
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable(["op": "stat", "mount": "/mnt/proj", "path": "hello.txt"])
            ) { response in
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad stat shape")
                }
                XCTAssertEqual(body["ino"], .number(Double(info.st_ino)))
                XCTAssertEqual(body["uid"], .number(Double(info.st_uid)))
                XCTAssertEqual(body["gid"], .number(Double(info.st_gid)))
                XCTAssertEqual(body["mode"], .number(Double(info.st_mode)))
            }
        }
    }

    /// isomorphic-git compares `Math.floor(ms / 1000)` against the seconds
    /// native git recorded, so a timestamp 0.9996 s past the second must not
    /// be rounded up into the next one — that file would be stale on every
    /// walk. Mirrors node-server's "never rounds a timestamp up" test.
    func testTimestampsAreNotRoundedIntoTheNextSecond() async throws {
        let racy = root + "/racy.txt"
        try Data("x".utf8).write(to: URL(fileURLWithPath: racy))
        let mtime = Date(timeIntervalSince1970: 1_700_000_000.9996)
        try FileManager.default.setAttributes([.modificationDate: mtime], ofItemAtPath: racy)
        var info = stat()
        XCTAssertEqual(stat(racy, &info), 0)
        let ctimeMs =
            Double(info.st_ctimespec.tv_sec) * 1000 + Double(info.st_ctimespec.tv_nsec) / 1_000_000

        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=racy.txt", method: .get
            ) { response in
                guard case .object(let body) = try self.decode(response.body),
                    case .number(let reportedMtime)? = body["mtime"],
                    case .number(let reportedCtime)? = body["ctime"]
                else { return XCTFail("bad stat shape") }
                XCTAssertEqual((reportedMtime / 1000).rounded(.down), 1_700_000_000)
                XCTAssertEqual(reportedCtime, ctimeMs)
                XCTAssertEqual(
                    (reportedCtime / 1000).rounded(.down), (ctimeMs / 1000).rounded(.down))
            }
            try await client.execute(
                uri: "/api/hostfs/list?mount=%2Fmnt%2Fproj&path=", method: .get
            ) { response in
                guard case .object(let body) = try self.decode(response.body),
                    case .array(let entries)? = body["entries"]
                else { return XCTFail("bad list shape") }
                let racyEntry = entries.first { entry in
                    guard case .object(let e) = entry, case .string("racy.txt")? = e["name"]
                    else { return false }
                    return true
                }
                guard case .object(let e)? = racyEntry,
                    case .number(let lastModified)? = e["lastModified"]
                else { return XCTFail("no racy.txt entry") }
                XCTAssertEqual((lastModified / 1000).rounded(.down), 1_700_000_000)
            }
        }
    }

    func testWriteMkdirRenameRemoveRoundTrip() async throws {
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/write?mount=%2Fmnt%2Fproj&path=new/deep/file.txt",
                method: .put,
                body: ByteBuffer(string: "written from test")
            ) { response in
                XCTAssertEqual(response.status, .ok)
            }
            let written = try String(
                contentsOf: URL(fileURLWithPath: root + "/new/deep/file.txt"), encoding: .utf8)
            XCTAssertEqual(written, "written from test")

            try await client.execute(
                uri: "/api/hostfs/mkdir?mount=%2Fmnt%2Fproj&path=made", method: .post
            ) { response in XCTAssertEqual(response.status, .ok) }
            try await client.execute(
                uri: "/api/hostfs/rename?mount=%2Fmnt%2Fproj&path=made&to=renamed", method: .post
            ) { response in XCTAssertEqual(response.status, .ok) }
            try await client.execute(
                uri: "/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=renamed&recursive=1",
                method: .delete
            ) { response in XCTAssertEqual(response.status, .ok) }
            // Removing the mount root itself is refused.
            try await client.execute(
                uri: "/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=&recursive=1", method: .delete
            ) { response in XCTAssertEqual(response.status, .forbidden) }
            // Non-recursive remove of a non-empty directory is ENOTEMPTY.
            try await client.execute(
                uri: "/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=new", method: .delete
            ) { response in
                XCTAssertEqual(response.status, .conflict)
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad error shape")
                }
                XCTAssertEqual(body["code"], .string("ENOTEMPTY"))
            }
        }
    }

    func testErrnoMapping() async throws {
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=missing.txt", method: .get
            ) { response in
                XCTAssertEqual(response.status, .notFound)
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad error shape")
                }
                XCTAssertEqual(body["code"], .string("ENOENT"))
            }
            try await client.execute(
                uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=sub", method: .get
            ) { response in
                XCTAssertEqual(response.status, .conflict)
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad error shape")
                }
                XCTAssertEqual(body["code"], .string("EISDIR"))
            }
            try await client.execute(
                uri: "/api/hostfs/list?mount=%2Fmnt%2Fnope&path=", method: .get
            ) { response in XCTAssertEqual(response.status, .notFound) }
        }
    }

    func testTraversalAndSymlinkEscapesAreForbidden() async throws {
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=..%2Fsecret.txt", method: .get
            ) { response in XCTAssertEqual(response.status, .forbidden) }
            try await client.execute(
                uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=escape-link%2Fsecret.txt",
                method: .get
            ) { response in XCTAssertEqual(response.status, .forbidden) }
            // Writes under an escaping symlinked ancestor are rejected too.
            try await client.execute(
                uri: "/api/hostfs/write?mount=%2Fmnt%2Fproj&path=escape-link/new.txt",
                method: .put,
                body: ByteBuffer(string: "x")
            ) { response in XCTAssertEqual(response.status, .forbidden) }
        }
    }

    /// One URL for every metadata op is the whole point of the stable
    /// endpoint: the CORS preflight cache is keyed by URL, so the per-op
    /// `?mount=&path=` routes never got a cache hit (#2715).
    private func stable(_ body: [String: Any]) throws -> ByteBuffer {
        ByteBuffer(data: try JSONSerialization.data(withJSONObject: body))
    }

    func testStableEndpointListStatMkdirRenameRemove() async throws {
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable(["op": "list", "mount": "/mnt/proj", "path": ""])
            ) { response in
                XCTAssertEqual(response.status, .ok)
                guard case .object(let body) = try self.decode(response.body),
                    case .array(let entries)? = body["entries"]
                else { return XCTFail("bad list shape") }
                XCTAssertEqual(entries.count, 3)
            }
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable(["op": "stat", "mount": "/mnt/proj", "path": "hello.txt"])
            ) { response in
                XCTAssertEqual(response.status, .ok)
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad stat shape")
                }
                XCTAssertEqual(body["kind"], .string("file"))
                XCTAssertEqual(body["size"], .number(10))
            }
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable(["op": "mkdir", "mount": "/mnt/proj", "path": "post/made"])
            ) { response in XCTAssertEqual(response.status, .ok) }
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable([
                    "op": "rename", "mount": "/mnt/proj", "path": "post/made", "to": "post/moved",
                ])
            ) { response in XCTAssertEqual(response.status, .ok) }
            // `recursive` accepts the query-string "1" and a JSON true alike.
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable([
                    "op": "remove", "mount": "/mnt/proj", "path": "post/moved", "recursive": true,
                ])
            ) { response in XCTAssertEqual(response.status, .ok) }
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable([
                    "op": "remove", "mount": "/mnt/proj", "path": "post", "recursive": "1",
                ])
            ) { response in XCTAssertEqual(response.status, .ok) }
        }
    }

    /// Every failure MUST carry an errno `code` — a code-less 404 is exactly
    /// how `HostFsMountBackend` decides a bridge has no stable endpoint and
    /// downgrades to the per-op routes for the rest of its life.
    func testStableEndpointErrorsAlwaysCarryACode() async throws {
        try await makeApp().test(.router) { client in
            func expectCode(_ body: [String: Any], _ status: HTTPResponse.Status, _ code: String)
                async throws
            {
                try await client.execute(
                    uri: "/api/hostfs", method: .post, body: try self.stable(body)
                ) { response in
                    XCTAssertEqual(response.status, status)
                    guard case .object(let payload) = try self.decode(response.body) else {
                        return XCTFail("bad error shape")
                    }
                    XCTAssertEqual(payload["code"], .string(code))
                }
            }
            try await expectCode(
                ["op": "stat", "mount": "/mnt/proj", "path": "missing.txt"], .notFound, "ENOENT")
            try await expectCode(
                ["op": "stat", "mount": "/mnt/proj", "path": "../secret.txt"], .forbidden, "EACCES")
            try await expectCode(["op": "list", "mount": "/mnt/nope", "path": ""], .notFound, "ENOENT")
            try await expectCode(
                ["op": "remove", "mount": "/mnt/proj", "path": "", "recursive": true], .forbidden,
                "EACCES")
            // `read` is deliberately NOT a stable-endpoint op (it keeps its
            // cacheable per-file GET), so it is rejected as unknown.
            try await expectCode(
                ["op": "read", "mount": "/mnt/proj", "path": "hello.txt"], .badRequest, "EINVAL")
            try await expectCode(
                ["op": "rename", "mount": "/mnt/proj", "path": "hello.txt"], .badRequest, "EINVAL")
            try await client.execute(
                uri: "/api/hostfs", method: .post, body: ByteBuffer(string: "not json")
            ) { response in
                XCTAssertEqual(response.status, .badRequest)
                guard case .object(let payload) = try self.decode(response.body) else {
                    return XCTFail("bad error shape")
                }
                XCTAssertEqual(payload["code"], .string("EINVAL"))
            }
        }
    }

    /// Oversized and unparseable are distinct answers on both bridges:
    /// node-server's `hostFsBodyErrorHandler` maps `entity.too.large` to
    /// 413 EFBIG and every other body-parser failure to 400 EINVAL.
    func testStableEndpointOversizedBodyIsCodedEFBIG() async throws {
        try await makeApp().test(.router) { client in
            let oversized = String(repeating: "x", count: HostFSRoutes.stableMaxBodyBytes + 1024)
            let body = try self.stable(["op": "stat", "mount": "/mnt/proj", "path": oversized])
            try await client.execute(uri: "/api/hostfs", method: .post, body: body) { response in
                XCTAssertEqual(response.status, .contentTooLarge)
                guard case .object(let payload) = try self.decode(response.body) else {
                    return XCTFail("bad error shape")
                }
                XCTAssertEqual(payload["code"], .string("EFBIG"))
            }
        }
    }

    func testPreflightMaxAgeMatchesNodeServer() {
        XCTAssertEqual(BridgeSecurity.preflightMaxAge("/api/hostfs"), "7200")
        XCTAssertEqual(BridgeSecurity.preflightMaxAge("/api/hostfs/read"), "7200")
        XCTAssertEqual(BridgeSecurity.preflightMaxAge("/api/fetch-proxy"), "600")
        XCTAssertEqual(BridgeSecurity.preflightMaxAge("/api/hostfs-admin"), "600")
    }

    func testResolveWithinRootLexicalRules() throws {
        XCTAssertEqual(try HostFSRoutes.resolveWithinRoot(root: root, relPath: ""), root)
        XCTAssertEqual(
            try HostFSRoutes.resolveWithinRoot(root: root, relPath: "a/b"), root + "/a/b")
        XCTAssertThrowsError(try HostFSRoutes.resolveWithinRoot(root: root, relPath: "../x"))
        XCTAssertThrowsError(try HostFSRoutes.resolveWithinRoot(root: root, relPath: "a/../../x"))
    }
}
