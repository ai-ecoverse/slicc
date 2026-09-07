import Foundation

// Generation-tagged Client→Chrome frame buffering for the `/cdp` proxy
// (issue #2417). Split out of `CDPProxy.swift` so the policy — which frames
// may still be delivered after a Chrome-leg reset or a client supersession —
// reads on its own and can be tested without the actor.

/// The `{chromeConnection, client}` pair a buffer's frames were written for.
/// A buffer is flushed only when both halves still match at flush time; see
/// `CDPProxy.clientFrameBufferDropReason`.
struct ClientFrameBufferGeneration: Equatable, Sendable {
    /// Id of the Chrome connection that was live when buffering started, or
    /// `nil` when no leg was live at all (initial connect / a leg that never
    /// opened). `nil` flushes onto any connection; a concrete id only flushes
    /// onto that same connection, which a post-drop replacement never is.
    let chromeConnectionID: UUID?
    /// Id of the client that held the single `/cdp` slot, or `nil` for none.
    let clientID: UUID?
}

/// Buffered Client→Chrome frames plus the generation they belong to.
struct ClientFrameBuffer: Sendable {
    let generation: ClientFrameBufferGeneration
    var messages: [ProxyMessage] = []
}

/// Why a buffer was dropped rather than flushed. Raw values appear verbatim in
/// the `[cdp-proxy] Dropped N buffered client frame(s) — <reason>` log line and
/// match node-server's `ClientFrameBufferDropReason`.
enum ClientFrameBufferDropReason: String, Sendable {
    case chromeLegReset = "chrome-leg-reset"
    case clientSuperseded = "client-superseded"
    case clientDisconnected = "client-disconnected"
    case upstreamReset = "upstream-reset"
    case noClient = "no-client"
}

extension CDPProxy {
    /// Decide whether a buffer may be flushed onto the connection identified by
    /// `chromeConnectionID`. Returns `nil` when the flush is safe, otherwise the
    /// drop reason. Static + pure so the policy is testable on its own; byte-
    /// mirrored by `clientFrameBufferDropReason` in
    /// `packages/node-server/src/cdp-proxy/client-frame-buffer.ts`.
    static func clientFrameBufferDropReason(
        generation: ClientFrameBufferGeneration,
        chromeConnectionID: UUID?,
        clientID: UUID?
    ) -> ClientFrameBufferDropReason? {
        if let bufferedFor = generation.chromeConnectionID, bufferedFor != chromeConnectionID {
            return .chromeLegReset
        }
        guard let clientID else {
            return .noClient
        }
        if generation.clientID != clientID {
            return .clientSuperseded
        }
        return nil
    }
}
