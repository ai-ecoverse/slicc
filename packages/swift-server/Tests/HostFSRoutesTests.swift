import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import NIOCore
import XCTest

@testable import slicc_server



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

    
    
    
    func testReadHonorsByteRanges() async throws {
        try await makeApp().test(.router) { client in
            func read(_ range: String?, _ check: @escaping (TestResponse) throws -> Void)
                async throws
            {
                var headers = HTTPFields()
                if let range { headers[HostFSRoutes.rangeHeader] = range }
                try await client.execute(
                    uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt", method: .get,
                    headers: headers
                ) { response in try check(response) }
            }
            
            try await read("bytes=6-9") { response in
                XCTAssertEqual(response.status, .partialContent)
                XCTAssertEqual(response.headers[HostFSRoutes.contentRangeHeader], "bytes 6-9/10")
                XCTAssertEqual(response.headers[HostFSRoutes.acceptRangesHeader], "bytes")
                var buffer = response.body
                XCTAssertEqual(
                    buffer.readData(length: buffer.readableBytes) ?? Data(), Data("host".utf8))
            }
            try await read("bytes=-4") { response in
                XCTAssertEqual(response.status, .partialContent)
                XCTAssertEqual(response.headers[HostFSRoutes.contentRangeHeader], "bytes 6-9/10")
            }
            try await read("bytes=99-120") { response in
                XCTAssertEqual(response.status, .rangeNotSatisfiable)
                XCTAssertEqual(response.headers[HostFSRoutes.contentRangeHeader], "bytes */10")
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad error shape")
                }
                XCTAssertEqual(body["code"], .string("EINVAL"))
            }
            
            try await read("items=0-2") { response in
                XCTAssertEqual(response.status, .ok)
                var buffer = response.body
                XCTAssertEqual(
                    buffer.readData(length: buffer.readableBytes) ?? Data(),
                    Data("hello host".utf8))
            }
            try await read(nil) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertEqual(response.headers[HostFSRoutes.acceptRangesHeader], "bytes")
            }
        }
    }

    
    
    
    func testLargeAndOpenEndedRangesAreStreamed() async throws {
        
        
        let bigLength = HostFSRoutes.streamChunkBytes * 2 + 12345
        var pattern = Data(count: bigLength)
        for index in stride(from: 0, to: bigLength, by: 4093) {
            pattern[index] = UInt8(index % 251)
        }
        let bigPath = root + "/big.pack"
        try pattern.write(to: URL(fileURLWithPath: bigPath))
        defer { try? FileManager.default.removeItem(atPath: bigPath) }

        try await makeApp().test(.router) { client in
            func readBig(_ range: String?, _ check: @escaping (TestResponse) throws -> Void)
                async throws
            {
                var headers = HTTPFields()
                if let range { headers[HostFSRoutes.rangeHeader] = range }
                try await client.execute(
                    uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=big.pack", method: .get,
                    headers: headers
                ) { response in try check(response) }
            }
            
            try await readBig("bytes=0-") { response in
                XCTAssertEqual(response.status, .partialContent)
                XCTAssertEqual(
                    response.headers[HostFSRoutes.contentRangeHeader],
                    "bytes 0-\(bigLength - 1)/\(bigLength)")
                var buffer = response.body
                XCTAssertEqual(buffer.readData(length: buffer.readableBytes) ?? Data(), pattern)
            }
            
            let start = HostFSRoutes.streamChunkBytes - 7
            let end = HostFSRoutes.streamChunkBytes * 2 + 11
            try await readBig("bytes=\(start)-\(end)") { response in
                XCTAssertEqual(response.status, .partialContent)
                var buffer = response.body
                XCTAssertEqual(
                    buffer.readData(length: buffer.readableBytes) ?? Data(),
                    pattern.subdata(in: start..<(end + 1)))
            }
            
            try await readBig(nil) { response in
                XCTAssertEqual(response.status, .ok)
                var buffer = response.body
                XCTAssertEqual(buffer.readData(length: buffer.readableBytes) ?? Data(), pattern)
            }
        }
    }

    
    
    
    
    func testConditionalRequests() async throws {
        try await makeApp().test(.router) { client in
            func read(_ headers: HTTPFields, _ check: @escaping (TestResponse) throws -> Void)
                async throws
            {
                try await client.execute(
                    uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=hello.txt", method: .get,
                    headers: headers
                ) { response in try check(response) }
            }
            var etag = ""
            var lastModified = ""
            try await read(HTTPFields()) { response in
                XCTAssertEqual(response.status, .ok)
                etag = response.headers[HostFSRoutes.etagHeader] ?? ""
                lastModified = response.headers[HostFSRoutes.lastModifiedHeader] ?? ""
                XCTAssertFalse(etag.isEmpty)
                XCTAssertFalse(lastModified.isEmpty)
                
                XCTAssertFalse(etag.hasPrefix("W/"))
            }
            
            var conditional = HTTPFields()
            conditional[HostFSRoutes.ifNoneMatchHeader] = etag
            try await read(conditional) { response in
                XCTAssertEqual(response.status, .notModified)
                XCTAssertEqual(response.body.readableBytes, 0)
                XCTAssertEqual(response.headers[HostFSRoutes.etagHeader], etag)
            }
            
            var weak = HTTPFields()
            weak[HostFSRoutes.ifNoneMatchHeader] = "W/" + etag
            try await read(weak) { XCTAssertEqual($0.status, .notModified) }
            var star = HTTPFields()
            star[HostFSRoutes.ifNoneMatchHeader] = "*"
            try await read(star) { XCTAssertEqual($0.status, .notModified) }
            var stale = HTTPFields()
            stale[HostFSRoutes.ifNoneMatchHeader] = "\"stale\""
            try await read(stale) { XCTAssertEqual($0.status, .ok) }
            
            var since = HTTPFields()
            since[HostFSRoutes.ifModifiedSinceHeader] = lastModified
            try await read(since) { XCTAssertEqual($0.status, .notModified) }
            
            var withRange = HTTPFields()
            withRange[HostFSRoutes.rangeHeader] = "bytes=6-9"
            withRange[HostFSRoutes.ifRangeHeader] = etag
            try await read(withRange) { XCTAssertEqual($0.status, .partialContent) }
            var staleRange = HTTPFields()
            staleRange[HostFSRoutes.rangeHeader] = "bytes=6-9"
            staleRange[HostFSRoutes.ifRangeHeader] = "\"not-the-current-tag\""
            try await read(staleRange) { response in
                XCTAssertEqual(response.status, .ok)
                XCTAssertNil(response.headers[HostFSRoutes.contentRangeHeader])
            }
        }
    }

    
    
    func testChangedMtimeInvalidatesTheValidator() throws {
        let path = root + "/hello.txt"
        let before = HostFSRoutes.cacheValidator(path: path, size: 10, mtimeMs: 1_700_000_000_000)
        let after = HostFSRoutes.cacheValidator(path: path, size: 10, mtimeMs: 1_700_000_060_000)
        XCTAssertNotEqual(before.etag, after.etag)
        XCTAssertNotEqual(before.lastModified, after.lastModified)
        
        let resized = HostFSRoutes.cacheValidator(path: path, size: 11, mtimeMs: 1_700_000_000_000)
        XCTAssertNotEqual(before.etag, resized.etag)
    }

    
    func testParseByteRangeMatchesNodeServer() {
        XCTAssertEqual(HostFSRoutes.parseByteRange("bytes=0-9", size: 100), .window(start: 0, end: 9))
        XCTAssertEqual(
            HostFSRoutes.parseByteRange("bytes=90-", size: 100), .window(start: 90, end: 99))
        XCTAssertEqual(
            HostFSRoutes.parseByteRange("bytes=-10", size: 100), .window(start: 90, end: 99))
        
        XCTAssertEqual(
            HostFSRoutes.parseByteRange("bytes=-500", size: 100), .window(start: 0, end: 99))
        
        XCTAssertEqual(
            HostFSRoutes.parseByteRange("bytes=6-9999", size: 10), .window(start: 6, end: 9))
        for header in [nil, "", "bytes=", "items=0-1", "bytes=0-1, 5-6", "bytes=a-b"] {
            XCTAssertEqual(HostFSRoutes.parseByteRange(header, size: 100), .whole, "\(header ?? "nil")")
        }
        XCTAssertEqual(HostFSRoutes.parseByteRange("bytes=-", size: 100), .whole)
        XCTAssertEqual(HostFSRoutes.parseByteRange("bytes=100-200", size: 100), .unsatisfiable)
        XCTAssertEqual(HostFSRoutes.parseByteRange("bytes=-0", size: 100), .unsatisfiable)
        XCTAssertEqual(HostFSRoutes.parseByteRange("bytes=9-3", size: 100), .unsatisfiable)
        
        XCTAssertEqual(HostFSRoutes.parseByteRange("bytes=0-0", size: 0), .unsatisfiable)
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

    
    
    
    
    func testStatReportsIdentityFieldsForCompareStats() async throws {
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: root + "/hello.txt")
        var info = stat()
        XCTAssertEqual(stat(root + "/hello.txt", &info), 0)
        let inode = Double(info.st_ino)
        let device = Double(info.st_dev)
        let uid = Double(info.st_uid)
        let gid = Double(info.st_gid)
        let fullMode = Double(info.st_mode)
        let ctimeMs =
            Double(info.st_ctimespec.tv_sec) * 1000
            + Double(info.st_ctimespec.tv_nsec) / 1_000_000
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=hello.txt", method: .get
            ) { response in
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad stat shape")
                }
                XCTAssertEqual(body["ino"], .number(inode))
                XCTAssertEqual(body["dev"], .number(device))
                XCTAssertEqual(body["uid"], .number(uid))
                XCTAssertEqual(body["gid"], .number(gid))
                
                
                XCTAssertEqual(body["mode"], .number(fullMode))
                guard case .number(let mode)? = body["mode"] else { return XCTFail("no mode") }
                XCTAssertEqual(mode_t(mode) & 0o777, 0o755)
                
                
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
                XCTAssertEqual(e["ino"], .number(inode))
                XCTAssertEqual(e["dev"], .number(device))
                XCTAssertEqual(e["mode"], .number(fullMode))
            }
            
            
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable(["op": "stat", "mount": "/mnt/proj", "path": "hello.txt"])
            ) { response in
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad stat shape")
                }
                XCTAssertEqual(body["ino"], .number(inode))
                XCTAssertEqual(body["dev"], .number(device))
                XCTAssertEqual(body["uid"], .number(uid))
                XCTAssertEqual(body["gid"], .number(gid))
                XCTAssertEqual(body["mode"], .number(fullMode))
            }
        }
    }

    
    
    
    
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
            
            try await client.execute(
                uri: "/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=&recursive=1", method: .delete
            ) { response in XCTAssertEqual(response.status, .forbidden) }
            
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
            
            try await client.execute(
                uri: "/api/hostfs/write?mount=%2Fmnt%2Fproj&path=escape-link/new.txt",
                method: .put,
                body: ByteBuffer(string: "x")
            ) { response in XCTAssertEqual(response.status, .forbidden) }
        }
    }

    
    
    
    private func stable(_ body: [String: Any]) throws -> ByteBuffer {
        ByteBuffer(data: try JSONSerialization.data(withJSONObject: body))
    }

    
    
    func testSameFileRenameIsANoOpAndPreservesBytes() async throws {
        let payload = Data("same-inode-must-survive".utf8)
        let hardDir = root + "/hardlink-rename"
        try FileManager.default.createDirectory(atPath: hardDir, withIntermediateDirectories: true)
        let from = hardDir + "/a.txt"
        let to = hardDir + "/b.txt"
        try payload.write(to: URL(fileURLWithPath: from))
        try FileManager.default.linkItem(atPath: from, toPath: to)

        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable([
                    "op": "rename", "mount": "/mnt/proj",
                    "path": "hardlink-rename/a.txt", "to": "hardlink-rename/b.txt",
                ])
            ) { response in XCTAssertEqual(response.status, .ok) }
        }
        let names = try FileManager.default.contentsOfDirectory(atPath: hardDir)
        XCTAssertTrue(names.contains("a.txt"))
        XCTAssertTrue(names.contains("b.txt"))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: from)), payload)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: to)), payload)

        try await clientRename(
            path: "distinct-rename/from.txt", to: "distinct-rename/to.txt",
            seed: "distinct-rename/from.txt", body: payload)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: root + "/distinct-rename/from.txt"))
        XCTAssertEqual(
            try Data(contentsOf: URL(fileURLWithPath: root + "/distinct-rename/to.txt")), payload)

        let caseCollapsed = try volumeCollapses("Slicc.md", "SLICC.md")
        try await clientRename(
            path: "case-rename/Slicc.md", to: "case-rename/SLICC.md",
            seed: "case-rename/Slicc.md", body: payload)
        let caseNames = try FileManager.default.contentsOfDirectory(
            atPath: root + "/case-rename")
        if caseCollapsed {
            XCTAssertEqual(caseNames, ["Slicc.md"])
            XCTAssertEqual(
                try Data(contentsOf: URL(fileURLWithPath: root + "/case-rename/Slicc.md")), payload)
        } else {
            XCTAssertEqual(caseNames, ["SLICC.md"])
            XCTAssertEqual(
                try Data(contentsOf: URL(fileURLWithPath: root + "/case-rename/SLICC.md")), payload)
        }

        let nfd = "Groeger-Familieo\u{0308}.md"
        let nfc = "Groeger-Familie\u{00f6}.md"
        let nfcCollapsed = try volumeCollapses(nfd, nfc)
        try await clientRename(
            path: "nfc-rename/" + nfd, to: "nfc-rename/" + nfc,
            seed: "nfc-rename/" + nfd, body: payload)
        let nfcNames = try FileManager.default.contentsOfDirectory(atPath: root + "/nfc-rename")
        if nfcCollapsed {
            XCTAssertEqual(nfcNames, [nfd])
            XCTAssertEqual(
                try Data(contentsOf: URL(fileURLWithPath: root + "/nfc-rename/" + nfd)), payload)
        } else {
            XCTAssertEqual(nfcNames, [nfc])
            XCTAssertEqual(
                try Data(contentsOf: URL(fileURLWithPath: root + "/nfc-rename/" + nfc)), payload)
        }
    }

    private func volumeCollapses(_ a: String, _ b: String) throws -> Bool {
        let probe = root + "/probe-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: probe, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: URL(fileURLWithPath: probe + "/" + a))
        let existsB = FileManager.default.fileExists(atPath: probe + "/" + b)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: probe)) ?? []
        try FileManager.default.removeItem(atPath: probe)
        return existsB && names.contains(a)
    }

    private func clientRename(path: String, to: String, seed: String, body: Data) async throws {
        let seedUrl = URL(fileURLWithPath: root + "/" + seed)
        try FileManager.default.createDirectory(
            at: seedUrl.deletingLastPathComponent(), withIntermediateDirectories: true)
        try body.write(to: seedUrl)
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs", method: .post,
                body: try self.stable([
                    "op": "rename", "mount": "/mnt/proj", "path": path, "to": to,
                ])
            ) { response in XCTAssertEqual(response.status, .ok) }
        }
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

    
    
    
    
    
    
    
    
    func testListOmitsMetadataForAnEntryItCannotStat() async throws {
        try FileManager.default.createSymbolicLink(
            atPath: root + "/dangling", withDestinationPath: root + "/not-there")
        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/list?mount=%2Fmnt%2Fproj&path=", method: .get
            ) { response in
                XCTAssertEqual(response.status, .ok)
                guard case .object(let body) = try self.decode(response.body),
                    case .array(let entries)? = body["entries"]
                else { return XCTFail("bad list shape") }
                let dangling = entries.first { entry in
                    guard case .object(let e) = entry, case .string("dangling")? = e["name"]
                    else { return false }
                    return true
                }
                guard case .object(let e)? = dangling else { return XCTFail("no dangling entry") }
                
                XCTAssertEqual(e["kind"], .string("file"))
                XCTAssertNil(e["size"])
                XCTAssertNil(e["lastModified"])
                XCTAssertNil(e["ctime"])
                XCTAssertNil(e["ino"])
                XCTAssertNil(e["mode"])
                
                let hello = entries.first { entry in
                    guard case .object(let h) = entry, case .string("hello.txt")? = h["name"]
                    else { return false }
                    return true
                }
                guard case .object(let h)? = hello else { return XCTFail("no hello.txt entry") }
                XCTAssertEqual(h["size"], .number(10))
            }
            
            try await client.execute(
                uri: "/api/hostfs/stat?mount=%2Fmnt%2Fproj&path=dangling", method: .get
            ) { response in
                XCTAssertEqual(response.status, .notFound)
            }
        }
    }

    func testResolveWithinRootLexicalRules() throws {
        XCTAssertEqual(try HostFSRoutes.resolveWithinRoot(root: root, relPath: ""), root)
        XCTAssertEqual(
            try HostFSRoutes.resolveWithinRoot(root: root, relPath: "a/b"), root + "/a/b")
        XCTAssertThrowsError(try HostFSRoutes.resolveWithinRoot(root: root, relPath: "../x"))
        XCTAssertThrowsError(try HostFSRoutes.resolveWithinRoot(root: root, relPath: "a/../../x"))
    }

    func testReadWindowAndIfRangeDateValidation() throws {
        let path = root + "/window.txt"
        try "0123456789".write(toFile: path, atomically: true, encoding: .utf8)
        XCTAssertEqual(try HostFSRoutes.readWindow(path: path, start: 3, length: 4), Data("3456".utf8))

        let validator = HostFSRoutes.cacheValidator(path: path, size: 10, mtimeMs: 1_000_000)
        var headers = HTTPFields()
        headers[HostFSRoutes.ifRangeHeader] = validator.lastModified
        XCTAssertTrue(HostFSRoutes.ifRangeAllowsRange(headers, validator))

        headers = HTTPFields()
        headers[HostFSRoutes.ifModifiedSinceHeader] = "not-a-date"
        XCTAssertFalse(HostFSRoutes.isNotModified(headers, validator))
        headers = HTTPFields()
        headers[HostFSRoutes.ifRangeHeader] = "not-a-date"
        XCTAssertFalse(HostFSRoutes.ifRangeAllowsRange(headers, validator))
    }

    func testLargeWholeFileDirectoryWriteAndMissingRemoveReturnSpecificErrors() async throws {
        let sparsePath = root + "/oversized.pack"
        FileManager.default.createFile(atPath: sparsePath, contents: Data())
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: sparsePath))
        try handle.truncate(atOffset: UInt64(HostFSRoutes.maxBodyBytes + 1))
        try handle.close()

        try await makeApp().test(.router) { client in
            try await client.execute(
                uri: "/api/hostfs/read?mount=%2Fmnt%2Fproj&path=oversized.pack",
                method: .get
            ) { response in
                XCTAssertEqual(response.status, .contentTooLarge)
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad oversized response")
                }
                XCTAssertEqual(body["code"], .string("EFBIG"))
            }
            try await client.execute(
                uri: "/api/hostfs/write?mount=%2Fmnt%2Fproj&path=sub",
                method: .put,
                body: ByteBuffer(string: "cannot replace directory")
            ) { response in
                XCTAssertEqual(response.status, .conflict)
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad directory response")
                }
                XCTAssertEqual(body["code"], .string("EISDIR"))
            }
            try await client.execute(
                uri: "/api/hostfs/remove?mount=%2Fmnt%2Fproj&path=missing",
                method: .delete
            ) { response in
                XCTAssertEqual(response.status, .notFound)
                guard case .object(let body) = try self.decode(response.body) else {
                    return XCTFail("bad missing response")
                }
                XCTAssertEqual(body["code"], .string("ENOENT"))
            }
        }

        XCTAssertTrue(
            HostFSRoutes.resolveRoots(
                mounts: [.init(hostPath: root + "/absent", path: "/mnt/absent")]
            ).isEmpty
        )
    }

    func testErrnoMappingPreservesKnownFailuresAndMapsSystemErrors() throws {
        let expected: [(Int, String)] = [
            (Int(ENOENT), "ENOENT"),
            (Int(EACCES), "EACCES"),
            (Int(EPERM), "EACCES"),
            (Int(EISDIR), "EISDIR"),
            (Int(ENOTDIR), "ENOTDIR"),
            (Int(ENOTEMPTY), "ENOTEMPTY"),
            (Int(EEXIST), "EEXIST"),
            (Int(EIO), "EIO"),
        ]
        for (code, expectedCode) in expected {
            XCTAssertThrowsError(
                try HostFSRoutes.wrapErrno { () in
                    throw NSError(domain: NSPOSIXErrorDomain, code: code)
                }
            ) { error in
                guard case HostFSRoutes.FsFailure.code(let actual, _, _) = error else {
                    return XCTFail("unexpected error: \(error)")
                }
                XCTAssertEqual(actual, expectedCode)
            }
        }

        let underlying = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOENT))
        XCTAssertThrowsError(
            try HostFSRoutes.wrapErrno { () in
                throw NSError(domain: NSCocoaErrorDomain, code: 1, userInfo: [NSUnderlyingErrorKey: underlying])
            }
        )
        XCTAssertThrowsError(
            try HostFSRoutes.wrapErrno { () in
                throw NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError)
            }
        )

        let original = HostFSRoutes.FsFailure.code("ORIGINAL", .badRequest, "kept")
        XCTAssertThrowsError(try HostFSRoutes.wrapErrno { () in throw original })
    }
}
