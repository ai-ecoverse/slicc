import Foundation
import SliccTrayFollower
import WebRTC
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "ComputerTrayFollower")








@MainActor
final class ComputerTrayFollower: NSObject {
    static let runtime = "sliccstart-computer"

    private let makeConnector: (URL) -> TrayFollowerConnecting
    private let makeCapturer: () -> ComputerCapturing
    private var permissions: ComputerPermissions
    private let eventSink: ComputerEventSink

    private var connector: TrayFollowerConnecting?
    private var startTask: Task<Void, Never>?
    private var lastSync: Task<Void, Never>?
    private var lastCapture: Task<Void, Never>?
    private var sendData: ((Data) -> Bool)?
    private var reassembler = TrayChunkReassembler()
    private var capturer: ComputerCapturing?
    private var joinUrl: URL?
    private var seq = 0
    private var currentRequestId: String?
    private var nativeSize = CGSize(width: 1, height: 1)
    private var lastMaxWidth: Int?
    private var lastInput: Task<Void, Never>?

    init(
        makeConnector: @escaping (URL) -> TrayFollowerConnecting = {
            TrayFollowerConnector(joinUrl: $0)
        },
        makeCapturer: (() -> ComputerCapturing)? = nil,
        permissions: ComputerPermissions = ComputerPermissions(),
        eventSink: ComputerEventSink = LiveCGEventSink()
    ) {
        self.makeConnector = makeConnector
        self.makeCapturer = makeCapturer ?? { ScreenCaptureKitCapturer() }
        self.permissions = permissions
        self.eventSink = eventSink
        super.init()
    }

    func leaderChanged(joinUrl rawJoinUrl: String?) {
        let url = rawJoinUrl.flatMap(URL.init(string:))
        guard url?.absoluteString != joinUrl?.absoluteString || url == nil else { return }
        stop()
        joinUrl = url
        guard url != nil else { return }
        refresh()
    }

    func refresh() {
        guard startTask == nil else { return }
        let task = Task { @MainActor [weak self] in
            await self?.syncConnection()
            self?.startTask = nil
        }
        startTask = task
        lastSync = task
    }

    func _testing_settle() async {
        await lastSync?.value
        await lastInput?.value
        await lastCapture?.value
        await lastCapture?.value
    }

    func stop() {
        startTask?.cancel()
        startTask = nil
        teardownConnection()
    }

    private func teardownConnection() {
        capturer?.stop()
        capturer = nil
        currentRequestId = nil
        connector?.stop()
        connector = nil
        sendData = nil
        reassembler = TrayChunkReassembler()
    }

    private func syncConnection() async {
        guard let url = joinUrl else {
            teardownConnection()
            return
        }
        guard !Task.isCancelled, joinUrl?.absoluteString == url.absoluteString else { return }
        guard connector == nil else { return }

        let connector = makeConnector(url)
        connector.delegate = self
        self.connector = connector
        do {
            try await connector.start()
        } catch {
            log.error("Computer tray follower could not attach: \(String(describing: error))")
            if self.connector === connector { self.connector = nil }
        }
    }

    private func send(_ message: FollowerToLeaderMessage) -> Bool {
        guard let sendData, let data = try? JSONEncoder().encode(message) else { return false }
        return sendData(data)
    }

    func route(_ data: Data) {
        struct Envelope: Decodable { let type: String }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return }
        if envelope.type == TrayChunkFrame.typeTag {
            guard let frame = try? JSONDecoder().decode(TrayChunkFrame.self, from: data),
                let message = reassembler.accept(frame).message
            else { return }
            route(message)
            return
        }
        guard let message = try? JSONDecoder().decode(LeaderToFollowerMessage.self, from: data)
        else { return }
        route(message)
    }

    func route(_ message: LeaderToFollowerMessage) {
        switch message {
        case .ping:
            _ = send(.pong)
        case .computerNativeCapture(let requestId, let fps, let maxWidth, let watch):
            lastCapture = Task { await handleCapture(requestId: requestId, fps: fps, maxWidth: maxWidth, watch: watch) }
        case .computerNativeUnwatch:
            capturer?.stop()
            capturer = nil
            currentRequestId = nil
        case .computerNativeInput(let requestId, let events):
            lastInput = Task { await handleInput(requestId: requestId, events: events) }
        default:
            break
        }
    }

    private func handleCapture(requestId: String, fps: Double?, maxWidth: Double?, watch: Bool?)
        async
    {
        do {
            try permissions.ensureScreenRecording()
        } catch {
            _ = send(
                .computerNativeError(
                    requestId: requestId, error: ComputerCaptureFailure.message(for: error)))
            return
        }
        capturer?.stop()
        let capturer = makeCapturer()
        self.capturer = capturer
        currentRequestId = requestId
        let fpsValue = fps ?? 2
        let width = maxWidth.map { Int($0.rounded()) }
        lastMaxWidth = width
        let watching = watch ?? false
        do {
            try await capturer.start(
                fps: fpsValue, maxWidth: width, watch: watching,
                onFrame: { [weak self] image, native in
                    self?.emitFrame(requestId: requestId, image: image, native: native)
                },
                onEnded: { [weak self] in
                    guard watching, let self else { return }
                    self.lastCapture = Task { @MainActor in
                        await self.handleCapture(
                            requestId: requestId, fps: fps, maxWidth: maxWidth, watch: true)
                    }
                })
        } catch {
            _ = send(
                .computerNativeError(
                    requestId: requestId, error: ComputerCaptureFailure.message(for: error)))
        }
    }

    private func emitFrame(requestId: String, image: CGImage, native: CGSize) {
        guard currentRequestId == requestId else { return }
        guard
            let encoded = ComputerFrameEncoder.jpeg(from: image, maxWidth: lastMaxWidth)
        else {
            _ = send(
                .computerNativeError(
                    requestId: requestId, error: ComputerCaptureError.encodeFailed.message))
            return
        }
        seq += 1
        let nativeW = native.width > 0 ? native.width : CGFloat(encoded.nativeWidth)
        let nativeH = native.height > 0 ? native.height : CGFloat(encoded.nativeHeight)
        nativeSize = CGSize(width: nativeW, height: nativeH)
        let b64 = encoded.data.base64EncodedString()
        for message in ComputerNativeFraming.messages(
            requestId: requestId,
            seq: seq,
            width: Double(encoded.width),
            height: Double(encoded.height),
            nativeWidth: Double(nativeW),
            nativeHeight: Double(nativeH),
            data: b64)
        {
            _ = send(message)
        }
    }

    private func handleInput(requestId: String, events: [ComputerInputEvent]) async {
        
        do {
            try permissions.ensureAccessibility()
            var injector = ComputerInputInjector(
                sink: eventSink, encodedSize: nativeSize, nativeSize: nativeSize)
            try await injector.apply(events)
            _ = send(.computerNativeInputResult(requestId: requestId, error: nil))
        } catch {
            let text = ComputerCaptureFailure.message(for: error)
            _ = send(.computerNativeError(requestId: requestId, error: text))
            _ = send(.computerNativeInputResult(requestId: requestId, error: text))
        }
    }
}

extension ComputerTrayFollower: TrayFollowerConnectorDelegate {
    nonisolated func connector(
        _ connector: TrayFollowerConnector, didConnect channelSend: @escaping (Data) -> Bool
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            sendData = channelSend
            let host = ProcessInfo.processInfo.hostName
            _ = send(
                .hello(
                    protocolVersion: traySyncProtocolVersion,
                    runtime: ComputerTrayFollower.runtime,
                    capabilities: TraySyncCapabilities(exec: false, computer: true),
                    motd: "Native screen capture on \(host)"))
        }
    }

    nonisolated func connectorDidDisconnect(_ connector: TrayFollowerConnector, reason: String) {
        Task { @MainActor [weak self] in
            self?.sendData = nil
            self?.capturer?.stop()
            self?.capturer = nil
        }
    }

    nonisolated func connector(_ connector: TrayFollowerConnector, isReconnecting attempt: Int) {}

    nonisolated func connector(_ connector: TrayFollowerConnector, didGiveUp lastError: String) {
        Task { @MainActor [weak self] in
            self?.teardownConnection()
        }
    }

    nonisolated func connector(
        _ connector: TrayFollowerConnector, didReceiveInfo trayId: String, participantCount: Int
    ) {}

    nonisolated func connector(
        _ connector: TrayFollowerConnector, didGenerateCandidate candidate: RTCIceCandidate
    ) {}

    nonisolated func connector(_ connector: TrayFollowerConnector, didReceiveData data: Data) {
        Task { @MainActor [weak self] in self?.route(data) }
    }
}
