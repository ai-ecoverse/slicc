import Foundation














public enum TrayChunkLimits {
    
    
    
    public static let maxMessageBytes = 65536
    
    static let envelopeBytes = 512
    
    
    
    static let worstCaseBytesPerCharacter = 4
    
    static let maxChunkBytes = 32 * 1024
    
    public static let maxTotalBytes = 8 * 1024 * 1024
    
    
    
    
    
    
    
    public static let sendHighWaterBytes = 8 * 1024 * 1024
    
    public static let maxPending = 8
    
    
    
    public static let maxChunkCount = 8192
    
    
    public static let maxReassemblyBytes = 32 * 1024 * 1024
}



public enum TrayChunkFraming {
    
    
    
    
    
    
    
    
    
    public static func frameChunks(_ text: String, chunkId: String = UUID().uuidString) -> [TrayChunkFrame] {
        let budget = max(
            1,
            min(
                TrayChunkLimits.maxChunkBytes,
                (TrayChunkLimits.maxMessageBytes - TrayChunkLimits.envelopeBytes)
                    / TrayChunkLimits.worstCaseBytesPerCharacter))

        var slices: [String] = []
        var current = String.UnicodeScalarView()
        var currentBytes = 0
        for scalar in text.unicodeScalars {
            let size = String(scalar).utf8.count
            if currentBytes + size > budget, !current.isEmpty {
                slices.append(String(current))
                current = String.UnicodeScalarView()
                currentBytes = 0
            }
            current.append(scalar)
            currentBytes += size
        }
        if !current.isEmpty || slices.isEmpty { slices.append(String(current)) }

        return slices.enumerated().map { index, slice in
            TrayChunkFrame(
                type: TrayChunkFrame.typeTag,
                chunkId: chunkId,
                chunkIndex: index,
                totalChunks: slices.count,
                chunkData: slice)
        }
    }
}









public struct TrayChunkReassembler {
    
    public enum Rejection: Equatable {
        case malformed
        case oversize
    }

    public struct Outcome {
        
        public let message: Data?
        
        public let rejection: Rejection?

        static let pending = Outcome(message: nil, rejection: nil)
        static func rejected(_ rejection: Rejection) -> Outcome {
            Outcome(message: nil, rejection: rejection)
        }
        static func completed(_ message: Data) -> Outcome {
            Outcome(message: message, rejection: nil)
        }
    }

    private struct Buffer {
        var chunks: [String?]
        var received: Int
        var bytes: Int
        let startedAt: Date

        init(totalChunks: Int) {
            self.chunks = Array(repeating: nil, count: totalChunks)
            self.received = 0
            self.bytes = 0
            self.startedAt = Date()
        }
    }

    private var buffers: [String: Buffer] = [:]

    public init() {}

    
    public var isEmpty: Bool { buffers.isEmpty }

    public mutating func accept(_ frame: TrayChunkFrame) -> Outcome {
        guard frame.hasValidIndices,
            frame.totalChunks <= TrayChunkLimits.maxChunkCount
        else {
            return .rejected(.malformed)
        }
        
        
        if let existing = buffers[frame.chunkId], existing.chunks.count != frame.totalChunks {
            return .rejected(.malformed)
        }

        if buffers[frame.chunkId] == nil {
            buffers[frame.chunkId] = Buffer(totalChunks: frame.totalChunks)
            evictOldestIfNeeded()
        }
        guard var buffer = buffers[frame.chunkId],
            frame.chunkIndex < buffer.chunks.count,
            buffer.chunks[frame.chunkIndex] == nil
        else { return .pending }

        buffer.chunks[frame.chunkIndex] = frame.chunkData
        buffer.received += 1
        buffer.bytes += frame.chunkData.utf8.count

        guard buffer.bytes <= TrayChunkLimits.maxTotalBytes else {
            buffers.removeValue(forKey: frame.chunkId)
            return .rejected(.oversize)
        }
        guard buffer.received >= buffer.chunks.count else {
            buffers[frame.chunkId] = buffer
            return .pending
        }

        buffers.removeValue(forKey: frame.chunkId)
        let assembled = buffer.chunks.compactMap { $0 }.joined()
        guard let data = assembled.data(using: .utf8) else { return .rejected(.malformed) }
        return .completed(data)
    }

    public mutating func removeAll() {
        buffers.removeAll()
    }

    private mutating func evictOldestIfNeeded() {
        while buffers.count > TrayChunkLimits.maxPending {
            guard let oldest = buffers.min(by: { $0.value.startedAt < $1.value.startedAt })
            else { return }
            buffers.removeValue(forKey: oldest.key)
        }
    }
}
