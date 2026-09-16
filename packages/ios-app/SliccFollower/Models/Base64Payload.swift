import Foundation
import UniformTypeIdentifiers

struct Base64Payload: Equatable, Identifiable {

    var id: String { "\(mime):\(bytes.count):\(bytes.prefix(16).map { String($0, radix: 16) }.joined())" }

    let bytes: Data

    let mime: String

    let text: Bool

    let source: Source

    enum Source: String, Equatable {
        case magic
        case declared
        case content
    }

    static let syntheticStem = "payload"

    var name: String {
        guard let ext = UTType(mimeType: mime)?.preferredFilenameExtension else {
            return Self.syntheticStem
        }
        return "\(Self.syntheticStem).\(ext)"
    }

    var shortLabel: String {
        if let sub = mime.split(separator: "/").last {
            return sub.uppercased()
        }
        return mime.uppercased()
    }

    static func identify(_ data: String, declaredMime: String? = nil) -> Base64Payload? {
        guard let bytes = Data(base64Encoded: data), !bytes.isEmpty else { return nil }

        if let magic = MagicBytes.sniff(bytes) {
            return Base64Payload(bytes: bytes, mime: magic, text: isTextMime(magic), source: .magic)
        }
        let declared = declaredMime?.split(separator: ";", maxSplits: 1).first?
            .trimmingCharacters(in: .whitespaces).lowercased()
        if let declared, !declared.isEmpty, declared != "application/octet-stream" {
            return Base64Payload(
                bytes: bytes, mime: declared, text: isTextMime(declared), source: .declared)
        }

        if MagicBytes.looksLikeText(bytes) {
            return Base64Payload(bytes: bytes, mime: "text/plain", text: true, source: .content)
        }
        return nil
    }

    static func isTextMime(_ mime: String) -> Bool {
        if mime.hasPrefix("text/") { return true }
        return [
            "application/json", "application/xml", "application/javascript",
            "application/x-sh", "application/x-yaml", "image/svg+xml",
        ].contains(mime)
    }
}

enum MagicBytes {
    private struct Signature {
        let offset: Int
        let bytes: [UInt8]
        let mime: String

        var also: (offset: Int, bytes: [UInt8])?
    }

    private static func ascii(_ s: String) -> [UInt8] { Array(s.utf8) }

    private static let signatures: [Signature] = [

        Signature(offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], mime: "image/png"),
        Signature(offset: 0, bytes: [0xFF, 0xD8, 0xFF], mime: "image/jpeg"),
        Signature(offset: 0, bytes: ascii("GIF87a"), mime: "image/gif"),
        Signature(offset: 0, bytes: ascii("GIF89a"), mime: "image/gif"),
        Signature(offset: 0, bytes: ascii("BM"), mime: "image/bmp"),
        Signature(
            offset: 0, bytes: ascii("RIFF"), mime: "image/webp",
            also: (offset: 8, bytes: ascii("WEBP"))),
        Signature(offset: 4, bytes: ascii("ftypavif"), mime: "image/avif"),
        Signature(offset: 0, bytes: [0x00, 0x00, 0x01, 0x00], mime: "image/x-icon"),

        Signature(
            offset: 0, bytes: ascii("RIFF"), mime: "audio/wav",
            also: (offset: 8, bytes: ascii("WAVE"))),
        Signature(offset: 0, bytes: ascii("ID3"), mime: "audio/mpeg"),
        Signature(offset: 0, bytes: ascii("fLaC"), mime: "audio/flac"),
        Signature(offset: 4, bytes: ascii("ftypM4A"), mime: "audio/mp4"),

        Signature(offset: 4, bytes: ascii("ftypisom"), mime: "video/mp4"),
        Signature(offset: 4, bytes: ascii("ftypmp42"), mime: "video/mp4"),
        Signature(offset: 4, bytes: ascii("ftypqt"), mime: "video/quicktime"),
        Signature(offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3], mime: "video/webm"),

        Signature(offset: 0, bytes: ascii("%PDF-"), mime: "application/pdf"),

        Signature(offset: 0, bytes: [0x00, 0x61, 0x73, 0x6D], mime: "application/wasm"),
        Signature(offset: 0, bytes: [0x50, 0x4B, 0x03, 0x04], mime: "application/zip"),
        Signature(offset: 0, bytes: [0x1F, 0x8B], mime: "application/gzip"),
        Signature(offset: 0, bytes: [0x7F, 0x45, 0x4C, 0x46], mime: "application/x-executable"),
        Signature(offset: 0, bytes: [0xCA, 0xFE, 0xBA, 0xBE], mime: "application/x-mach-binary"),
    ]
    .sorted { ($0.bytes.count + ($0.also?.bytes.count ?? 0)) > ($1.bytes.count + ($1.also?.bytes.count ?? 0)) }

    private static let oggMagic: [UInt8] = Array("OggS".utf8)

    private static func matches(_ data: Data, at offset: Int, _ bytes: [UInt8]) -> Bool {
        guard offset >= 0, offset + bytes.count <= data.count else { return false }
        for (i, byte) in bytes.enumerated() where data[data.startIndex + offset + i] != byte {
            return false
        }
        return true
    }

    private static func contains(_ haystack: Data, _ needle: [UInt8]) -> Bool {
        guard !needle.isEmpty, haystack.count >= needle.count else { return false }
        let bytes = Array(haystack)
        for start in 0...(bytes.count - needle.count)
        where Array(bytes[start..<(start + needle.count)]) == needle {
            return true
        }
        return false
    }

    static func sniff(_ data: Data) -> String? {
        for signature in signatures {
            guard matches(data, at: signature.offset, signature.bytes) else { continue }
            if let also = signature.also, !matches(data, at: also.offset, also.bytes) { continue }
            return signature.mime
        }
        if matches(data, at: 0, oggMagic) {

            let head = data.prefix(64)
            let video = [ascii("theora"), ascii("VP8")].contains { contains(head, $0) }
            return video ? "video/ogg" : "audio/ogg"
        }
        return nil
    }

    static let textSniffWindow = 4096

    static func looksLikeText(_ data: Data) -> Bool {
        if data.isEmpty { return true }
        var window = data.prefix(textSniffWindow)
        if window.contains(0x00) { return false }
        if window.count == textSniffWindow {
            var back = 0
            while back < 4, let last = window.last {
                if last & 0x80 == 0 { break }
                window = window.dropLast()
                back += 1
                if last & 0xC0 == 0xC0 { break }
            }
        }
        guard let text = String(data: Data(window), encoding: .utf8) else { return false }
        var suspicious = 0
        var total = 0
        for scalar in text.unicodeScalars {
            total += 1
            let code = scalar.value

            if code == 0x09 || code == 0x0A || code == 0x0D || code == 0x0C || code == 0x1B {
                continue
            }
            if code < 0x20 || code == 0x7F { suspicious += 1 }
        }
        return Double(suspicious) <= Double(total) * 0.05
    }
}
