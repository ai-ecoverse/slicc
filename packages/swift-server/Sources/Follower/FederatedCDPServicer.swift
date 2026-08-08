import Foundation
import Logging
import SliccTrayFollower

// Swift port of node-server's `electron-federated-cdp.ts` — the "expose CDP over
// CDP" core for egress-blocked Electron apps (e.g. Signal).
//
// A normal SLICC follower runs the webapp in the target's renderer and lets the
// leader drive its browser over the tray sync protocol. Signal's renderer blocks
// all network egress, so the webapp can't run there — but slicc-server DOES have
// the app's raw CDP (the `--cdp-port` it launched Signal with). This servicer
// makes the SERVER the follower's CDP surface: it connects to that raw CDP and
// translates the leader's tray-sync CDP messages to/from it, transparently.
//
// It is TRANSPORT-AGNOSTIC: the caller supplies a `send(FollowerToLeaderMessage)`
// sink and feeds it leader `cdp.request`s via `handleCdpRequest`. The
// `ElectronTrayFollower` coordinator wires the WebRTC data channel that carries
// these messages. The pure translators (`buildTargetsAdvertise`,
// `buildCdpResponses`, `buildCdpEvent`) are unit-tested against node's shapes.

// MARK: - CDP response chunking constants (mirror shared-ts `sendCDPResponse`)

/// CDP responses whose serialized `result` exceeds this are chunked. Mirrors
/// `CDP_CHUNK_THRESHOLD` in `packages/shared-ts/src/tray-sync-protocol.ts`.
let cdpChunkThresholdBytes = 64 * 1024
/// Per-chunk payload size, below the threshold for safety margin. Mirrors the
/// TS `CDP_CHUNK_SIZE`.
let cdpChunkSizeBytes = 32 * 1024

/// A CDP target as returned by `/json/list`.
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

// MARK: - Pure translators

/// Build a `targets.advertise` message advertising the app's page targets to the
/// leader (which namespaces them into its aggregated `targets.registry`). Only
/// `page`-type targets are exposed — devtools/service-worker/etc. are not
/// driveable follower surfaces. `targetId` is the app's LOCAL CDP target id.
/// Mirrors node-server's `buildTargetsAdvertise`.
func buildTargetsAdvertise(
    runtimeId: String, targets: [FederatedCdpInspectableTarget]
) -> FollowerToLeaderMessage {
    let entries = targets.filter { $0.type == "page" }.map {
        RemoteTargetInfo(targetId: $0.id, title: $0.title ?? "", url: $0.url, kind: "browser")
    }
    return .targetsAdvertise(targets: entries, runtimeId: runtimeId)
}

/// Translate a raw CDP result/error into the `cdp.response` message(s) to send
/// back to the leader. An error (or absent result) is always small and sent as
/// one message. A large result is split into `chunkData` slices of its serialized
/// JSON, reassembled by the leader's `reassembleCDPResponse`. Mirrors
/// node-server's `buildCdpResponses` / shared-ts `sendCDPResponse`.
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

/// Translate a raw CDP event frame into a `cdp.event` tray-sync message.
/// Mirrors node-server's `buildCdpEvent`.
func buildCdpEvent(
    method: String, params: [String: Any]?, sessionId: String?
) -> FollowerToLeaderMessage {
    .cdpEvent(method: method, params: AnyCodable(params ?? [:]), sessionId: sessionId)
}

/// Translate one parsed raw CDP frame into the follower→leader messages it
/// produces. A frame with an `id` is a command reply correlated back to its
/// `requestId` via `pending` (and consumed from it); a frame with a `method`
/// and no `id` is an event. Pure so the correlation logic is unit-testable
/// without a live socket. Mirrors node-server's `onCdpFrame`.
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

/// Split an already-serialized result into chunks that each fit within
/// `maxBytes` once measured in UTF-8. Cut at Unicode scalar boundaries so every
/// slice is valid UTF-8 and their concatenation reproduces the original —
/// mirrors `TrayChunkFraming.frameChunks`, but without the frame envelope since
/// each slice becomes its own `cdp.response` message.
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

// MARK: - FederatedCDPServicer

/// Connects to the attached app's raw CDP and relays tray-sync CDP messages
/// to/from a leader over an injected `send` sink. Transparent: the leader manages
/// Target attachment / sessions itself (via forwarded `Target.*` requests), so
/// this servicer only maps `requestId ↔ CDP id` and translates envelopes.
actor FederatedCDPServicer {
    private let runtimeId: String
    private let send: @Sendable (FollowerToLeaderMessage) -> Void
    private let logger: Logger
    /// The CDP socket. Abstracted behind `CDPWebSocketTransport` (shared with
    /// `CDPBrowserSession`) so tests can drive the frame pump without a live
    /// browser.
    private var transport: (any CDPWebSocketTransport)?
    private var receiveLoop: Task<Void, Never>?
    private var nextCdpId = 0
    /// CDP frame id → leader requestId, for correlating responses.
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

    /// Open the CDP connection to the browser-level debugger endpoint and start
    /// pumping frames.
    func connect(browserWsUrl: URL, session: URLSession = .shared) {
        connect(transport: URLSessionCDPWebSocket(url: browserWsUrl, session: session))
    }

    /// Start pumping frames over an injected transport (production or a test
    /// double).
    func connect(transport: any CDPWebSocketTransport) {
        self.transport = transport
        receiveLoop = Task { [weak self] in await self?.readLoop() }
    }

    /// Advertise the app's page targets to the leader (from `/json/list`).
    func advertiseTargets(_ targets: [FederatedCdpInspectableTarget]) {
        send(buildTargetsAdvertise(runtimeId: runtimeId, targets: targets))
    }

    /// Service one leader `cdp.request`: forward it to the app's CDP (preserving
    /// `sessionId`) and correlate the eventual response by requestId.
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
        do {
            try await transport.sendFrame(data)
        } catch {
            failPending(id: id, message: "cdp-send-failed: \(error.localizedDescription)")
        }
    }

    /// Close the CDP connection and reject any in-flight requests.
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
        while !stopped, let transport = transport {
            do {
                let message = try await transport.receiveFrame()
                let data: Data
                switch message {
                case .data(let payload): data = payload
                case .string(let text): data = Data(text.utf8)
                @unknown default: continue
                }
                onCdpFrame(data)
            } catch {
                if !stopped {
                    logger.debug("federated CDP read loop ended: \(error.localizedDescription)")
                }
                return
            }
        }
    }

    private func onCdpFrame(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        for message in messagesForCdpFrame(object, pending: &pending) {
            send(message)
        }
    }
}
