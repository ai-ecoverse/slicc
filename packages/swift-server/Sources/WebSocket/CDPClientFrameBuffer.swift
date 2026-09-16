import Foundation

struct ClientFrameBufferGeneration: Equatable, Sendable {

    let chromeConnectionID: UUID?

    let clientID: UUID?
}

struct ClientFrameBuffer: Sendable {
    let generation: ClientFrameBufferGeneration
    var messages: [ProxyMessage] = []
}

enum ClientFrameBufferDropReason: String, Sendable {
    case chromeLegReset = "chrome-leg-reset"
    case clientSuperseded = "client-superseded"
    case clientDisconnected = "client-disconnected"
    case upstreamReset = "upstream-reset"
    case noClient = "no-client"
}

extension CDPProxy {

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
