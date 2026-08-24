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

    func testResolveWithinRootLexicalRules() throws {
        XCTAssertEqual(try HostFSRoutes.resolveWithinRoot(root: root, relPath: ""), root)
        XCTAssertEqual(
            try HostFSRoutes.resolveWithinRoot(root: root, relPath: "a/b"), root + "/a/b")
        XCTAssertThrowsError(try HostFSRoutes.resolveWithinRoot(root: root, relPath: "../x"))
        XCTAssertThrowsError(try HostFSRoutes.resolveWithinRoot(root: root, relPath: "a/../../x"))
    }
}
