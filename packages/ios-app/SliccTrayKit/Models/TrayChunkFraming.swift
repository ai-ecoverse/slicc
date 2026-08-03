import Foundation

// Transport-level chunk framing for the tray data channel (#1700).
//
// Mirrors the framing half of `packages/shared-ts/src/tray-sync-protocol.ts`.
// A message whose serialized form exceeds the SCTP per-message limit is split
// into `TrayChunkFrame`s (declared in `SyncProtocol.swift`) and reassembled by
// the receiver before the message union is decoded at all.
//
// Kept separate from `AppState` so the framing and reassembly rules are
// testable without standing up an app, a WebRTC peer, or a data channel.

// MARK: - Limits

/// Bounds mirroring the TS constants in tray-sync-protocol.ts.
public enum TrayChunkLimits {
    /// Per-send SCTP ceiling. 65536 is the floor every SCTP implementation must
    /// accept (RFC 8831 §6.6), so framing to it is always safe regardless of
    /// what the peer negotiated.
    public static let maxMessageBytes = 65536
    /// Allowance for a frame's type/id/index fields.
    static let envelopeBytes = 512
    /// Bounds the growth of a slice of already-serialized JSON when it is
    /// re-escaped into a frame: a non-ASCII BMP character costs 3 UTF-8 bytes,
    /// re-escaped ASCII (`\` → `\\`) costs 2. 4 leaves margin.
    static let worstCaseBytesPerCharacter = 4
    /// Caps frame payload, matching the TS chunkers.
    static let maxChunkBytes = 32 * 1024
    /// Hard ceiling on one reassembled message.
    public static let maxTotalBytes = 8 * 1024 * 1024
    /// Queued-bytes ceiling above which a *chunked* send is refused: the next
    /// write is heading for a full send queue, and hundreds of frames would
    /// wedge the channel for everything behind them.
    ///
    /// Deliberately not applied to small messages, so a congested channel still
    /// passes keepalive ping/pong and a merely busy peer is not mistaken for a
    /// dead one. Mirrors `TRAY_SEND_HIGH_WATER_BYTES`.
    public static let sendHighWaterBytes = 8 * 1024 * 1024
    /// Concurrent in-flight reassemblies before the oldest is evicted.
    static let maxPending = 8
    /// Max frames one message may claim. Bounds the buffer allocated from a
    /// peer-controlled `totalChunks` before any payload arrives; far above the
    /// ~512 frames the 8 MiB cap produces at ~16 KiB each.
    static let maxChunkCount = 8192
}

// MARK: - Framing

public enum TrayChunkFraming {
    /// Split an already-serialized message into frames that each fit within the
    /// SCTP per-message limit once re-escaped as JSON.
    ///
    /// Slicing is measured in UTF-8 bytes and cut at Unicode *scalar*
    /// boundaries. Scalars rather than `Character`s because an extended grapheme
    /// cluster has no size bound — an emoji with many combining scalars can
    /// exceed the whole frame budget by itself, and appending it whole would
    /// produce an over-limit frame. Every scalar is at most 4 UTF-8 bytes, and
    /// cutting between scalars still yields valid UTF-8 on both sides.
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

// MARK: - Reassembly

/// Accumulates inbound frames until each message is whole.
///
/// Bounded on both axes and evicting oldest-first: a leader that starts many
/// large messages and finishes none must not grow follower memory without
/// limit. Frames are index-addressed, so out-of-order delivery is handled even
/// though SCTP data channels are ordered by default.
public struct TrayChunkReassembler {
    /// Why a frame produced no message, for the caller to log.
    public enum Rejection: Equatable {
        case malformed
        case oversize
    }

    public struct Outcome {
        /// The reassembled message, when this frame completed one.
        public let message: Data?
        /// Set when the frame was rejected rather than merely incomplete.
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

    /// True when at least one message is partially reassembled.
    public var isEmpty: Bool { buffers.isEmpty }

    public mutating func accept(_ frame: TrayChunkFrame) -> Outcome {
        guard frame.hasValidIndices,
            frame.totalChunks <= TrayChunkLimits.maxChunkCount
        else {
            return .rejected(.malformed)
        }
        // totalChunks must not change mid-message: a peer that re-declares it is
        // either buggy or probing the buffer sized by the first frame.
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
