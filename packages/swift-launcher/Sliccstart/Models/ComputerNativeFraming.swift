import Foundation
import SliccTrayFollower

/// CDP-style chunking for `computer.native.frame`, matching
/// `sendComputerNativeFrame` in `packages/shared-ts` (`CDP_CHUNK_THRESHOLD`
/// 64 KiB, `CDP_CHUNK_SIZE` 32 KiB).
enum ComputerNativeFraming {
    static let chunkThreshold = 64 * 1024
    static let chunkSize = 32 * 1024

    static func messages(
        requestId: String,
        seq: Int,
        mime: String = "image/jpeg",
        width: Double,
        height: Double,
        nativeWidth: Double,
        nativeHeight: Double,
        data: String
    ) -> [FollowerToLeaderMessage] {
        if data.utf8.count <= chunkThreshold {
            return [
                .computerNativeFrame(
                    requestId: requestId,
                    seq: seq,
                    mime: mime,
                    width: width,
                    height: height,
                    nativeWidth: nativeWidth,
                    nativeHeight: nativeHeight,
                    data: data,
                    chunkData: nil,
                    chunkIndex: nil,
                    totalChunks: nil)
            ]
        }
        let bytes = Array(data.utf8)
        let total = Int(ceil(Double(bytes.count) / Double(chunkSize)))
        return (0..<total).map { index in
            let start = index * chunkSize
            let end = min(start + chunkSize, bytes.count)
            let slice = String(bytes: bytes[start..<end], encoding: .utf8) ?? ""
            return .computerNativeFrame(
                requestId: requestId,
                seq: seq,
                mime: mime,
                width: width,
                height: height,
                nativeWidth: nativeWidth,
                nativeHeight: nativeHeight,
                data: nil,
                chunkData: slice,
                chunkIndex: index,
                totalChunks: total)
        }
    }
}
