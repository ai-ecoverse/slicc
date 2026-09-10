import Foundation
import NIOCore
import zlib

/// gzip-magic sniff + inflate for `/api/fetch-proxy`.
///
/// Mirrors `packages/node-server/src/fetch-proxy-gzip.ts`. An edge that
/// returns cached gzip bytes with no `content-encoding` (AEM/Fastly asked
/// for `identity`, #3037) still yields parseable JS/CSS. Declared gzip that
/// AsyncHTTPClient did not auto-decompress is inflated too — the synthetic
/// SW `Response` does not inflate `content-encoding`.
enum FetchProxyGzip {
    static let magic0: UInt8 = 0x1F
    static let magic1: UInt8 = 0x8B

    static func startsWithMagic(_ bytes: some Collection<UInt8>) -> Bool {
        var iterator = bytes.makeIterator()
        guard let first = iterator.next(), let second = iterator.next() else { return false }
        return first == magic0 && second == magic1
    }

    /// Empty and `identity` both mean "these bytes are the representation".
    static func contentEncodingLooksUncompressed(_ value: String?) -> Bool {
        let encoding = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return encoding.isEmpty || encoding == "identity"
    }

    static func gunzip(_ data: Data) throws -> Data {
        let inflater = GzipInflater()
        try inflater.start()
        let output = try inflater.push(Array(data), finish: true)
        return Data(output)
    }
}

enum FetchProxyGzipError: Error, Equatable {
    case inflateInit(Int32)
    case inflate(Int32)
}

/// Incremental gzip inflater. Not thread-safe; one iterator owns one instance.
/// Class so `z_stream` is never copied.
final class GzipInflater {
    private var stream = z_stream()
    private var started = false
    private var ended = false

    deinit {
        if started, !ended {
            inflateEnd(&stream)
        }
    }

    func start() throws {
        guard !started else { return }
        let rc = inflateInit2_(&stream, 15 + 16, zlibVersion(), Int32(MemoryLayout<z_stream>.size))
        guard rc == Z_OK else { throw FetchProxyGzipError.inflateInit(rc) }
        started = true
    }

    func push(_ input: [UInt8], finish: Bool) throws -> [UInt8] {
        try start()
        if ended { return [] }
        if input.isEmpty && !finish { return [] }
        return try input.withUnsafeBufferPointer { buf in
            try self.inflate(buf, finish: finish)
        }
    }

    private func inflate(_ buf: UnsafeBufferPointer<UInt8>, finish: Bool) throws -> [UInt8] {
        stream.next_in = UnsafeMutablePointer(mutating: buf.baseAddress)
        stream.avail_in = uInt(buf.count)
        var output: [UInt8] = []
        let chunk = 64 * 1024
        var outbuf = [UInt8](repeating: 0, count: chunk)
        let flush = finish ? Z_FINISH : Z_NO_FLUSH
        while true {
            let rc = outbuf.withUnsafeMutableBufferPointer { dest -> Int32 in
                self.stream.next_out = dest.baseAddress
                self.stream.avail_out = uInt(dest.count)
                return zlib.inflate(&self.stream, flush)
            }
            let produced = chunk - Int(stream.avail_out)
            if produced > 0 {
                output.append(contentsOf: outbuf[0..<produced])
            }
            if rc == Z_STREAM_END {
                ended = true
                inflateEnd(&stream)
                started = false
                break
            }
            if rc == Z_BUF_ERROR && stream.avail_in == 0 && !finish {
                break
            }
            guard rc == Z_OK else { throw FetchProxyGzipError.inflate(rc) }
            if stream.avail_in == 0 && !finish {
                break
            }
        }
        return output
    }
}

/// Pulls ByteBuffer chunks from an upstream iterator, inflating once the
/// first two bytes are gzip magic. Pass-through otherwise.
struct MaybeGunzipState<Iterator: AsyncIteratorProtocol> where Iterator.Element == ByteBuffer {
    private var decided = false
    private var inflater: GzipInflater?
    private var finished = false

    mutating func next(from inner: inout Iterator) async throws -> ByteBuffer? {
        if finished { return nil }
        if !decided {
            return try await decide(from: &inner)
        }
        if inflater != nil {
            return try await nextInflated(from: &inner)
        }
        return try await inner.next()
    }

    private mutating func decide(from inner: inout Iterator) async throws -> ByteBuffer? {
        var pending: [UInt8] = []
        while pending.count < 2 {
            guard let chunk = try await inner.next() else {
                decided = true
                if pending.isEmpty {
                    finished = true
                    return nil
                }
                return ByteBuffer(bytes: pending)
            }
            pending.append(contentsOf: chunk.readableBytesView)
        }
        decided = true
        guard FetchProxyGzip.startsWithMagic(pending) else {
            return ByteBuffer(bytes: pending)
        }
        let inflater = GzipInflater()
        let first = try inflater.push(pending, finish: false)
        self.inflater = inflater
        if first.isEmpty {
            return try await nextInflated(from: &inner)
        }
        return ByteBuffer(bytes: first)
    }

    private mutating func nextInflated(from inner: inout Iterator) async throws -> ByteBuffer? {
        while let chunk = try await inner.next() {
            let decoded = try inflater?.push(Array(chunk.readableBytesView), finish: false) ?? []
            if !decoded.isEmpty {
                return ByteBuffer(bytes: decoded)
            }
        }
        let tail = try inflater?.push([], finish: true) ?? []
        inflater = nil
        finished = true
        if tail.isEmpty { return nil }
        return ByteBuffer(bytes: tail)
    }
}
