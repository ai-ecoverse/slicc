import Combine
import SliccTrayFollower
import SliccTrayKit
import UIKit



@MainActor
final class ComputerLiveFrame: ObservableObject, Identifiable {
    let id: String
    @Published private(set) var image: UIImage?
    @Published private(set) var seq: Int = 0
    @Published private(set) var pixelSize: CGSize = .zero

    init(id: String) {
        self.id = id
    }

    func apply(image: UIImage, seq: Int, width: Double, height: Double) {
        guard seq >= self.seq else { return }
        self.image = image
        self.seq = seq
        pixelSize = CGSize(width: width, height: height)
    }
}







struct ComputerFrameAssembler {
    private struct Buffer {
        var chunks: [String?]
        var received: Int
        var total: Int
        var bytes: Int
    }

    private let maxChunkCount: Int
    private let maxPending: Int
    private let maxReassemblyBytes: Int
    private var buffers: [String: Buffer] = [:]
    private var order: [String] = []

    init(
        maxChunkCount: Int = TrayChunkLimits.maxChunkCount,
        maxPending: Int = TrayChunkLimits.maxPending,
        maxReassemblyBytes: Int = TrayChunkLimits.maxReassemblyBytes
    ) {
        self.maxChunkCount = maxChunkCount
        self.maxPending = maxPending
        self.maxReassemblyBytes = maxReassemblyBytes
    }

    var pendingCount: Int { buffers.count }

    mutating func accept(
        id: String, seq: Int, data: String?, chunkData: String?, chunkIndex: Int?, totalChunks: Int?
    ) -> String? {
        let key = bufferKey(id: id, seq: seq)
        if let data, chunkIndex == nil {
            evict(key)
            return data
        }
        guard let chunkData, let chunkIndex, let totalChunks, totalChunks > 0,
            totalChunks <= maxChunkCount, chunkIndex >= 0, chunkIndex < totalChunks
        else {
            return nil
        }
        if buffers[key] == nil {
            evictWhileNeeded(addingBytes: chunkData.utf8.count)
            guard buffers.count < maxPending,
                totalBytes + chunkData.utf8.count <= maxReassemblyBytes
            else {
                return nil
            }
            buffers[key] = Buffer(
                chunks: Array(repeating: nil, count: totalChunks), received: 0, total: totalChunks,
                bytes: 0)
            order.append(key)
        }
        guard var buffer = buffers[key], buffer.total == totalChunks else {
            evict(key)
            return nil
        }
        if buffer.chunks[chunkIndex] == nil {
            let extra = chunkData.utf8.count
            if totalBytes + extra > maxReassemblyBytes {
                evictWhileNeeded(addingBytes: extra)
                if totalBytes + extra > maxReassemblyBytes {
                    evict(key)
                    return nil
                }
            }
            buffer.chunks[chunkIndex] = chunkData
            buffer.received += 1
            buffer.bytes += extra
        }
        buffers[key] = buffer
        guard buffer.received >= buffer.total else { return nil }
        evict(key)
        return buffer.chunks.compactMap { $0 }.joined()
    }

    mutating func removeAll() {
        buffers.removeAll()
        order.removeAll()
    }

    private var totalBytes: Int {
        buffers.values.reduce(0) { $0 + $1.bytes }
    }

    private mutating func evictWhileNeeded(addingBytes: Int) {
        while !order.isEmpty,
            buffers.count >= maxPending || totalBytes + addingBytes > maxReassemblyBytes
        {
            evict(order[0])
        }
    }

    private mutating func evict(_ key: String) {
        buffers.removeValue(forKey: key)
        order.removeAll { $0 == key }
    }

    private func bufferKey(id: String, seq: Int) -> String {
        "\(id):\(seq)"
    }
}



@MainActor
final class ComputerRosterStorage {
    var liveFrames: [String: ComputerLiveFrame] = [:]
    var watchCounts: [String: Int] = [:]
    var assembler = ComputerFrameAssembler()
    #if DEBUG
        var outgoing: [FollowerToLeaderMessage] = []
    #endif
}
