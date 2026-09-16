import Foundation
import Logging
import SliccTrayFollower

let cdpChunkThresholdBytes = 64 * 1024

let cdpChunkSizeBytes = 32 * 1024

public struct FederatedCdpInspectableTarget: Sendable, Equatable {
    public let id: String
    public let type: String
    public let title: String?
    public let url: String

    public init(id: String, type: String, title: String?, url: String) {
        self.id = id
        self.type = type
        self.title = title
        self.url = url
    }
}

func buildTargetsAdvertise(
    runtimeId: String, targets: [FederatedCdpInspectableTarget]
) -> FollowerToLeaderMessage {
    let entries = targets.filter { $0.type == "page" }.map {
        RemoteTargetInfo(targetId: $0.id, title: $0.title ?? "", url: $0.url, kind: "browser")
    }
    return .targetsAdvertise(targets: entries, runtimeId: runtimeId)
}

func buildCdpResponses(
    requestId: String, result: [String: Any]?, error: String?
) -> [FollowerToLeaderMessage] {
    if let error = error {
        return [
            .cdpResponse(
                requestId: requestId, result: nil, error: error,
                chunkData: nil, chunkIndex: nil, totalChunks: nil)
        ]
    }
    guard let result = result else {
        return [
            .cdpResponse(
                requestId: requestId, result: nil, error: nil,
                chunkData: nil, chunkIndex: nil, totalChunks: nil)
        ]
    }
    let serializedData =
        (try? JSONSerialization.data(withJSONObject: result)) ?? Data("{}".utf8)
    if serializedData.count <= cdpChunkThresholdBytes {
        return [
            .cdpResponse(
                requestId: requestId, result: AnyCodable(result), error: nil,
                chunkData: nil, chunkIndex: nil, totalChunks: nil)
        ]
    }
    let serialized = String(decoding: serializedData, as: UTF8.self)
    let slices = chunkSerializedResult(serialized, maxBytes: cdpChunkSizeBytes)
    let total = slices.count
    return slices.enumerated().map { index, slice in
        .cdpResponse(
            requestId: requestId, result: nil, error: nil,
            chunkData: slice, chunkIndex: index, totalChunks: total)
    }
}

func buildCdpEvent(
    method: String, params: [String: Any]?, sessionId: String?
) -> FollowerToLeaderMessage {
    .cdpEvent(method: method, params: AnyCodable(params ?? [:]), sessionId: sessionId)
}

func messagesForCdpFrame(
    _ object: [String: Any], pending: inout [Int: String]
) -> [FollowerToLeaderMessage] {
    if let id = object["id"] as? Int {
        guard let requestId = pending[id] else { return [] }
        pending[id] = nil
        if let errorObject = object["error"] as? [String: Any] {
            let messageText = errorObject["message"] as? String ?? "cdp-error"
            return buildCdpResponses(requestId: requestId, result: nil, error: messageText)
        }
        let result = object["result"] as? [String: Any] ?? [:]
        return buildCdpResponses(requestId: requestId, result: result, error: nil)
    }
    if let method = object["method"] as? String {
        return [
            buildCdpEvent(
                method: method,
                params: object["params"] as? [String: Any],
                sessionId: object["sessionId"] as? String)
        ]
    }
    return []
}

func chunkSerializedResult(_ text: String, maxBytes: Int) -> [String] {
    let budget = max(1, maxBytes)
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
    return slices
}

actor FederatedCDPServicer {
    private let runtimeId: String
    private let send: @Sendable (FollowerToLeaderMessage) -> Void
    private let logger: Logger

    private var transport: (any CDPWebSocketTransport)?
    private var receiveLoop: Task<Void, Never>?
    private var nextCdpId = 0

    private var pending: [Int: String] = [:]
    private var stopped = false

    init(
        runtimeId: String,
        logger: Logger,
        send: @escaping @Sendable (FollowerToLeaderMessage) -> Void
    ) {
        self.runtimeId = runtimeId
        self.logger = logger
        self.send = send
    }

    private static let probeId = 999_999

    func connect(browserWsUrl: URL) async {
        logger.info("federated CDP servicer connecting to \(browserWsUrl.absoluteString)")
        do {
            let transport = try await WebSocketKitCDPTransport.connect(url: browserWsUrl.absoluteString)
            connect(transport: transport)
        } catch {
            logger.error(
                "federated CDP: WebSocket connect to app CDP FAILED — \(error.localizedDescription)")
        }
    }

    func connect(transport: any CDPWebSocketTransport) {
        self.transport = transport
        receiveLoop = Task { [weak self] in await self?.readLoop() }
        Task { [weak self] in await self?.probeConnection() }
    }

    private func probeConnection() async {
        guard let transport = transport else { return }
        let frame: [String: Any] = ["id": Self.probeId, "method": "Browser.getVersion"]
        guard let data = try? JSONSerialization.data(withJSONObject: frame) else { return }
        do {
            try await transport.sendFrame(data)
            logger.info("federated CDP probe: Browser.getVersion sent")
        } catch {
            logger.warning("federated CDP probe: send FAILED — \(error.localizedDescription)")
        }
    }

    func advertiseTargets(_ targets: [FederatedCdpInspectableTarget]) {
        send(buildTargetsAdvertise(runtimeId: runtimeId, targets: targets))
    }

    func handleCdpRequest(
        requestId: String, method: String, params: [String: Any]?, sessionId: String?
    ) async {
        guard let transport = transport, !stopped else {
            for message in buildCdpResponses(
                requestId: requestId, result: nil, error: "cdp-not-connected")
            {
                send(message)
            }
            return
        }
        nextCdpId += 1
        let id = nextCdpId
        pending[id] = requestId
        var frame: [String: Any] = ["id": id, "method": method, "params": params ?? [String: Any]()]
        if let sessionId = sessionId { frame["sessionId"] = sessionId }
        guard let data = try? JSONSerialization.data(withJSONObject: frame) else {
            pending[id] = nil
            return
        }
        logger.info("federated CDP → #\(id) \(method)\(sessionId.map { " sess=\($0.prefix(8))" } ?? "")")
        do {
            try await transport.sendFrame(data)
        } catch {
            logger.warning("federated CDP send FAILED #\(id) \(method) — \(error.localizedDescription)")
            failPending(id: id, message: "cdp-send-failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        stopped = true
        receiveLoop?.cancel()
        receiveLoop = nil
        for requestId in pending.values {
            for message in buildCdpResponses(requestId: requestId, result: nil, error: "cdp-closed") {
                send(message)
            }
        }
        pending.removeAll()
        let closing = transport
        transport = nil
        Task { await closing?.cancelSocket() }
    }

    private func failPending(id: Int, message: String) {
        guard let requestId = pending[id] else { return }
        pending[id] = nil
        for response in buildCdpResponses(requestId: requestId, result: nil, error: message) {
            send(response)
        }
    }

    private func readLoop() async {
        var frameCount = 0
        while !stopped, let transport = transport {
            do {
                let message = try await transport.receiveFrame()
                if frameCount == 0 { logger.info("federated CDP: first inbound frame from app CDP — socket is live") }
                frameCount += 1
                let data: Data
                switch message {
                case .data(let payload): data = payload
                case .string(let text): data = Data(text.utf8)
                @unknown default: continue
                }
                onCdpFrame(data)
            } catch {
                if !stopped {

                    logger.warning(
                        "federated CDP read loop ENDED after \(frameCount) frames (socket lost): \(error.localizedDescription)"
                    )
                    self.transport = nil
                }
                return
            }
        }
    }

    private func onCdpFrame(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        if object["id"] as? Int == Self.probeId {
            if let error = object["error"] as? [String: Any] {
                logger.warning("federated CDP probe: app CDP error — \(error["message"] as? String ?? "?")")
            } else {
                let product = (object["result"] as? [String: Any])?["product"] as? String ?? "?"
                logger.info("federated CDP probe: app CDP replied (\(product)) — socket round-trips OK")
            }
            return
        }
        for message in messagesForCdpFrame(object, pending: &pending) {
            send(message)
        }
    }
}
