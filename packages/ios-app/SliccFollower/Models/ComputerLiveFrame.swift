import Combine
import SliccTrayKit
import UIKit

/// One computer's latest JPEG. Cards and the full-screen view observe THIS
/// object, not the roster, so a 2 fps stream cannot rebuild the tab grid.
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

/// CDP-style `computer.frame` chunk reassembly. Mirrors
/// `reassembleComputerFrame` on the TypeScript side: a one-shot `data`
/// payload is already complete; `chunkData` / `chunkIndex` / `totalChunks`
/// wait until every slice has arrived.
struct ComputerFrameAssembler {
    private var buffers: [String: (chunks: [String?], received: Int, total: Int)] = [:]

    mutating func accept(
        id: String, seq: Int, data: String?, chunkData: String?, chunkIndex: Int?, totalChunks: Int?
    ) -> String? {
        if let data, chunkIndex == nil {
            buffers.removeValue(forKey: bufferKey(id: id, seq: seq))
            return data
        }
        guard let chunkData, let chunkIndex, let totalChunks, totalChunks > 0,
            chunkIndex >= 0, chunkIndex < totalChunks
        else {
            return nil
        }
        let key = bufferKey(id: id, seq: seq)
        var buffer = buffers[key] ?? (
            chunks: Array(repeating: nil, count: totalChunks), received: 0, total: totalChunks
        )
        if buffer.total != totalChunks {
            buffer = (chunks: Array(repeating: nil, count: totalChunks), received: 0, total: totalChunks)
        }
        if buffer.chunks[chunkIndex] == nil {
            buffer.chunks[chunkIndex] = chunkData
            buffer.received += 1
        }
        buffers[key] = buffer
        guard buffer.received >= buffer.total else { return nil }
        buffers.removeValue(forKey: key)
        return buffer.chunks.compactMap { $0 }.joined()
    }

    mutating func removeAll() {
        buffers.removeAll()
    }

    private func bufferKey(id: String, seq: Int) -> String {
        "\(id):\(seq)"
    }
}

/// Mutable computer-stream state. Stored properties cannot live on an
/// `AppState` extension (file-length cap), so the class holds this bag.
@MainActor
final class ComputerRosterStorage {
    var liveFrames: [String: ComputerLiveFrame] = [:]
    var watchCounts: [String: Int] = [:]
    var assembler = ComputerFrameAssembler()
    #if DEBUG
        var outgoing: [FollowerToLeaderMessage] = []
    #endif
}
