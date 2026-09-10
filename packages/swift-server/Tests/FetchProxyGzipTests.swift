import AsyncHTTPClient
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdTesting
import NIOCore
import NIOPosix
import XCTest
import zlib

@testable import slicc_server

final class FetchProxyGzipTests: XCTestCase {
    private let plainJS = "export const aem = 1;\n"

    func testMissingAndIdentityEncodingsLookUncompressed() {
        XCTAssertTrue(FetchProxyGzip.contentEncodingLooksUncompressed(nil))
        XCTAssertTrue(FetchProxyGzip.contentEncodingLooksUncompressed(""))
        XCTAssertTrue(FetchProxyGzip.contentEncodingLooksUncompressed("identity"))
        XCTAssertTrue(FetchProxyGzip.contentEncodingLooksUncompressed(" Identity "))
        XCTAssertFalse(FetchProxyGzip.contentEncodingLooksUncompressed("gzip"))
        XCTAssertFalse(FetchProxyGzip.contentEncodingLooksUncompressed("br"))
    }

    func testStartsWithMagic() throws {
        let gz = try gzipForTest(Array(plainJS.utf8))
        XCTAssertTrue(FetchProxyGzip.startsWithMagic(gz))
        XCTAssertFalse(FetchProxyGzip.startsWithMagic([FetchProxyGzip.magic0]))
        XCTAssertFalse(FetchProxyGzip.startsWithMagic(Array(plainJS.utf8)))
    }

    func testGunzipRoundTrip() throws {
        let gz = try gzipForTest(Array(plainJS.utf8))
        let out = try FetchProxyGzip.gunzip(Data(gz))
        XCTAssertEqual(String(data: out, encoding: .utf8), plainJS)
        XCTAssertFalse(FetchProxyGzip.startsWithMagic(out))
    }

    func testMaybeGunzipInflatesMagicAndPassesPlain() async throws {
        let gz = try gzipForTest(Array(plainJS.utf8))
        let inflated = try await collect(chunks: [ByteBuffer(bytes: gz)])
        XCTAssertEqual(String(buffer: inflated), plainJS)

        let plain = ByteBuffer(string: plainJS)
        let passed = try await collect(chunks: [plain])
        XCTAssertEqual(String(buffer: passed), plainJS)
    }

    func testMaybeGunzipInflatesWhenMagicIsSplitAcrossChunks() async throws {
        let gz = try gzipForTest(Array(plainJS.utf8))
        let first = ByteBuffer(bytes: Array(gz[0..<1]))
        let rest = ByteBuffer(bytes: Array(gz[1...]))
        let inflated = try await collect(chunks: [first, rest])
        XCTAssertEqual(String(buffer: inflated), plainJS)
    }

    func testTruncatedGzipThrows() async {
        let gz: [UInt8]
        do {
            gz = try gzipForTest(Array(plainJS.utf8))
        } catch {
            XCTFail("gzipForTest failed: \(error)")
            return
        }
        let truncated = Array(gz.prefix(8))
        do {
            _ = try await collect(chunks: [ByteBuffer(bytes: truncated)])
            XCTFail("truncated gzip must throw")
        } catch {
            // expected — zlib inflate rejects a truncated member
        }
    }

    private func collect(chunks: [ByteBuffer]) async throws -> ByteBuffer {
        var gzip = MaybeGunzipState<ChunkIterator>()
        var iterator = ChunkIterator(chunks: chunks)
        var out = ByteBuffer()
        while let chunk = try await gzip.next(from: &iterator) {
            var copy = chunk
            out.writeBuffer(&copy)
        }
        return out
    }

    func testFetchProxyDoesNotForceAcceptEncodingIdentity() async throws {
        let captured = AcceptEncodingBox()
        let upstreamRouter = Router()
        upstreamRouter.get("/upstream") { request, _ in
            await captured.record(request.headers[HTTPField.Name("accept-encoding")!] ?? "")
            return Response(
                status: .ok,
                headers: [.contentType: "text/plain; charset=utf-8"],
                body: .init(byteBuffer: ByteBuffer(string: "ok"))
            )
        }
        try await self.runLiveFetchProxy(upstreamRouter: upstreamRouter) { response in
            XCTAssertEqual(response.status, .ok)
        }
        let seen = await captured.value()
        XCTAssertNotEqual(seen, "identity", "proxy must not force accept-encoding: identity")
    }

    func testFetchProxyGunzipsJSWithNoContentEncoding() async throws {
        let js = "export function decorate() { return 1; }\n"
        let gz = try gzipForTest(Array(js.utf8))
        try await self.runFetchProxyGet(
            upstreamHeaders: [.contentType: "text/javascript; charset=utf-8"],
            upstreamBody: ByteBuffer(bytes: gz)
        ) { response in
            XCTAssertEqual(response.status, .ok)
            XCTAssertNil(response.headers[.contentEncoding], "decoded body must not claim gzip")
            XCTAssertEqual(String(buffer: response.body), js)
            XCTAssertFalse(FetchProxyGzip.startsWithMagic(response.body.readableBytesView))
        }
    }

    func testFetchProxyGunzipsCSSWithNoContentEncoding() async throws {
        let css = "body { color: red; }\n"
        let gz = try gzipForTest(Array(css.utf8))
        try await self.runFetchProxyGet(
            upstreamHeaders: [.contentType: "text/css; charset=utf-8"],
            upstreamBody: ByteBuffer(bytes: gz)
        ) { response in
            XCTAssertEqual(response.status, .ok)
            XCTAssertNil(response.headers[.contentEncoding])
            XCTAssertEqual(String(buffer: response.body), css)
        }
    }

    func testFetchProxyGunzipsDeclaredGzipJS() async throws {
        let js = "export const styles = true;\n"
        let gz = try gzipForTest(Array(js.utf8))
        try await self.runFetchProxyGet(
            upstreamHeaders: [
                .contentType: "text/javascript",
                .contentEncoding: "gzip",
            ],
            upstreamBody: ByteBuffer(bytes: gz)
        ) { response in
            XCTAssertEqual(response.status, .ok)
            XCTAssertNil(response.headers[.contentEncoding])
            XCTAssertEqual(String(buffer: response.body), js)
        }
    }

    func testFetchProxyForwardsPlainJSUnchanged() async throws {
        let js = "export const plain = true;\n"
        try await self.runFetchProxyGet(
            upstreamHeaders: [.contentType: "text/javascript"],
            upstreamBody: ByteBuffer(string: js)
        ) { response in
            XCTAssertEqual(response.status, .ok)
            XCTAssertNil(response.headers[.contentEncoding])
            XCTAssertEqual(String(buffer: response.body), js)
        }
    }

    private func runFetchProxyGet(
        upstreamHeaders: HTTPFields,
        upstreamBody: ByteBuffer,
        assert: @escaping @Sendable (TestResponse) throws -> Void
    ) async throws {
        let headers = upstreamHeaders
        let body = upstreamBody
        let upstreamRouter = Router()
        upstreamRouter.get("/upstream") { _, _ in
            Response(status: .ok, headers: headers, body: .init(byteBuffer: body))
        }
        try await self.runLiveFetchProxy(upstreamRouter: upstreamRouter, assert: assert)
    }

    private func runLiveFetchProxy(
        upstreamRouter: Router<BasicRequestContext>,
        assert: @escaping @Sendable (TestResponse) throws -> Void
    ) async throws {
        let upstreamApp = Application(responder: upstreamRouter.buildResponder())
        let eventLoopGroup = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        let httpClient = HTTPClient(eventLoopGroupProvider: .shared(eventLoopGroup))
        do {
            try await upstreamApp.test(.live) { upstreamClient in
                let upstreamPort = try XCTUnwrap(upstreamClient.port, "live test framework must expose a port")
                let proxyRouter = Router()
                registerAPIRoutes(
                    router: proxyRouter,
                    lickSystem: LickSystem(),
                    config: ServerConfig(
                        serveOnly: false,
                        cdpPort: 9222,
                        explicitCdpPort: false,
                        electron: false,
                        electronApp: nil,
                        electronAppURL: nil,
                        kill: false,
                        lead: false,
                        leadWorkerBaseUrl: nil,
                        leadWorkerBaseURL: nil,
                        profile: nil,
                        join: false,
                        joinUrl: nil,
                        joinURL: nil,
                        logLevel: "info",
                        logDir: nil,
                        logDirectoryURL: nil,
                        prompt: nil,
                        envFile: nil,
                        envFileURL: nil,
                        mounts: []
                    ),
                    httpClient: httpClient
                )
                let proxyApp = Application(responder: proxyRouter.buildResponder())
                try await proxyApp.test(.router) { proxyClient in
                    try await proxyClient.execute(
                        uri: "/api/fetch-proxy",
                        method: .get,
                        headers: [
                            HTTPField.Name("X-Target-URL")!: "http://localhost:\(upstreamPort)/upstream"
                        ]
                    ) { response in
                        try assert(response)
                    }
                }
            }
        } catch {
            try? await httpClient.shutdown()
            try? await eventLoopGroup.shutdownGracefully()
            throw error
        }
        try await httpClient.shutdown()
        try await eventLoopGroup.shutdownGracefully()
    }
}

private actor AcceptEncodingBox {
    private var stored = ""

    func record(_ value: String) {
        self.stored = value
    }

    func value() -> String {
        self.stored
    }
}

private struct ChunkIterator: AsyncIteratorProtocol {
    let chunks: [ByteBuffer]
    var index = 0

    mutating func next() async throws -> ByteBuffer? {
        guard index < chunks.count else { return nil }
        defer { index += 1 }
        return chunks[index]
    }
}

/// gzip-compress `input` with zlib (windowBits 15+16). Test-only.
func gzipForTest(_ input: [UInt8]) throws -> [UInt8] {
    var stream = z_stream()
    let initRC = deflateInit2_(
        &stream,
        Z_DEFAULT_COMPRESSION,
        Z_DEFLATED,
        15 + 16,
        8,
        Z_DEFAULT_STRATEGY,
        zlibVersion(),
        Int32(MemoryLayout<z_stream>.size)
    )
    guard initRC == Z_OK else { throw FetchProxyGzipError.inflateInit(initRC) }
    defer { deflateEnd(&stream) }
    return try input.withUnsafeBufferPointer { buf in
        stream.next_in = UnsafeMutablePointer(mutating: buf.baseAddress)
        stream.avail_in = uInt(buf.count)
        var output: [UInt8] = []
        var outbuf = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let rc = outbuf.withUnsafeMutableBufferPointer { dest -> Int32 in
                stream.next_out = dest.baseAddress
                stream.avail_out = uInt(dest.count)
                return deflate(&stream, Z_FINISH)
            }
            let produced = outbuf.count - Int(stream.avail_out)
            if produced > 0 {
                output.append(contentsOf: outbuf[0..<produced])
            }
            if rc == Z_STREAM_END { break }
            guard rc == Z_OK else { throw FetchProxyGzipError.inflate(rc) }
        }
        return output
    }
}
