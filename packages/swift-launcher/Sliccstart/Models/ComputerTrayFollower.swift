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
    
    
    
    
    private let pairId: String?
    
    
    
    
    var onConnected: (() -> Void)?
    
    
    
    
    var onGaveUp: ((String) -> Void)?

    
    
    
    private struct CaptureSlot {
        let capturer: ComputerCapturing
        let displayKey: Int
        let maxWidth: Int?
        let watch: Bool
    }

    private let makeDisplayGeometry: (Int?) throws -> ComputerDisplayGeometry
    private var connector: TrayFollowerConnecting?
    private var startTask: Task<Void, Never>?
    private var lastSync: Task<Void, Never>?
    private var captureTasks: [Task<Void, Never>] = []
    private var sendData: ((Data) -> Bool)?
    private var reassembler = TrayChunkReassembler()
    private var captures: [String: CaptureSlot] = [:]
    private var joinUrl: URL?
    private var seq = 0
    
    
    
    private var geometries: [Int: ComputerDisplayGeometry] = [:]
    private var lastInput: Task<Void, Never>?

    init(
        makeConnector: @escaping (URL) -> TrayFollowerConnecting = {
            TrayFollowerConnector(joinUrl: $0)
        },
        makeCapturer: (() -> ComputerCapturing)? = nil,
        permissions: ComputerPermissions = ComputerPermissions(),
        eventSink: ComputerEventSink = LiveCGEventSink(),
        pairId: String? = nil,
        makeDisplayGeometry: @escaping (Int?) throws -> ComputerDisplayGeometry = {
            try ScreenCaptureKitCapturer.liveGeometry(index: $0)
        }
    ) {
        self.makeConnector = makeConnector
        self.makeCapturer = makeCapturer ?? { ScreenCaptureKitCapturer() }
        self.makeDisplayGeometry = makeDisplayGeometry
        self.permissions = permissions
        self.eventSink = eventSink
        self.pairId = pairId
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
        
        while !captureTasks.isEmpty {
            let pending = captureTasks
            captureTasks.removeAll()
            for task in pending { await task.value }
        }
    }

    func stop() {
        startTask?.cancel()
        startTask = nil
        teardownConnection()
    }

    private func teardownConnection() {
        stopAllCaptures()
        geometries.removeAll()
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
            onGaveUp?(error.localizedDescription)
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
        case .computerNativeCapture(let requestId, let fps, let maxWidth, let display, let watch):
            queueCapture(
                requestId: requestId, fps: fps, maxWidth: maxWidth, display: display, watch: watch)
        case .computerNativeUnwatch(let requestId):
            if let requestId {
                stopCapture(requestId)
            } else {
                stopAllCaptures()
            }
        case .computerNativeInput(let requestId, let events, let display):
            lastInput = Task {
                await handleInput(requestId: requestId, events: events, display: display)
            }
        default:
            break
        }
    }

    private func queueCapture(
        requestId: String, fps: Double?, maxWidth: Double?, display: Double?, watch: Bool?
    ) {
        captureTasks.append(
            Task {
                await handleCapture(
                    requestId: requestId, fps: fps, maxWidth: maxWidth, display: display,
                    watch: watch)
            })
    }

    private func stopCapture(_ requestId: String) {
        captures.removeValue(forKey: requestId)?.capturer.stop()
    }

    private func stopAllCaptures() {
        let slots = captures.values
        captures.removeAll()
        for slot in slots { slot.capturer.stop() }
    }

    private func handleCapture(
        requestId: String, fps: Double?, maxWidth: Double?, display: Double?, watch: Bool?
    ) async {
        do {
            try permissions.ensureScreenRecording()
        } catch {
            _ = send(
                .computerNativeError(
                    requestId: requestId, error: ComputerCaptureFailure.message(for: error)))
            return
        }
        let displayIndex: Int?
        do {
            displayIndex = try Self.displayIndex(display)
        } catch {
            _ = send(
                .computerNativeError(
                    requestId: requestId, error: ComputerCaptureFailure.message(for: error)))
            return
        }
        let displayKey = displayIndex ?? 0
        let watching = watch ?? false
        stopCapture(requestId)
        if watching {
            
            
            for (id, slot) in captures where slot.watch && slot.displayKey == displayKey {
                stopCapture(id)
            }
        }
        let capturer = makeCapturer()
        captures[requestId] = CaptureSlot(
            capturer: capturer, displayKey: displayKey,
            maxWidth: maxWidth.flatMap(ComputerWireNumber.int), watch: watching)
        do {
            try await capturer.start(
                fps: fps ?? 2, maxWidth: captures[requestId]?.maxWidth, display: displayIndex,
                watch: watching,
                onFrame: { [weak self] image, geometry in
                    self?.emitFrame(requestId: requestId, image: image, geometry: geometry)
                },
                onEnded: { [weak self] in
                    guard watching, let self, self.captures[requestId]?.capturer === capturer
                    else { return }
                    self.queueCapture(
                        requestId: requestId, fps: fps, maxWidth: maxWidth, display: display,
                        watch: true)
                })
            if !watching, captures[requestId]?.capturer === capturer {
                captures.removeValue(forKey: requestId)
            }
        } catch {
            if captures[requestId]?.capturer === capturer {
                captures.removeValue(forKey: requestId)
            }
            _ = send(
                .computerNativeError(
                    requestId: requestId, error: ComputerCaptureFailure.message(for: error)))
        }
    }

    
    
    private static func displayIndex(_ display: Double?) throws -> Int? {
        guard let display else { return nil }
        guard let index = ComputerWireNumber.int(display) else {
            throw ComputerCaptureError.invalidDisplay(display)
        }
        return index
    }

    private func emitFrame(
        requestId: String, image: CGImage, geometry incoming: ComputerDisplayGeometry
    ) {
        guard let slot = captures[requestId] else { return }
        if !slot.watch { captures.removeValue(forKey: requestId) }
        guard
            let encoded = ComputerFrameEncoder.jpeg(from: image, maxWidth: slot.maxWidth)
        else {
            _ = send(
                .computerNativeError(
                    requestId: requestId, error: ComputerCaptureError.encodeFailed.message))
            return
        }
        seq += 1
        
        
        let fallback = CGSize(
            width: CGFloat(encoded.nativeWidth), height: CGFloat(encoded.nativeHeight))
        let geometry =
            incoming.pixelSize.width > 0 && incoming.pixelSize.height > 0
            ? incoming : .identity(size: fallback)
        geometries[slot.displayKey] = geometry
        let b64 = encoded.data.base64EncodedString()
        for message in ComputerNativeFraming.messages(
            requestId: requestId,
            seq: seq,
            width: Double(encoded.width),
            height: Double(encoded.height),
            nativeWidth: Double(geometry.pixelSize.width),
            nativeHeight: Double(geometry.pixelSize.height),
            data: b64)
        {
            _ = send(message)
        }
    }

    private func handleInput(
        requestId: String, events: [ComputerInputEvent], display: Double?
    ) async {
        
        
        
        
        do {
            try permissions.ensureAccessibility()
            let index = try Self.displayIndex(display)
            let geometry = try geometries[index ?? 0] ?? makeDisplayGeometry(index)
            var injector = ComputerInputInjector(
                sink: eventSink, encodedSize: geometry.pixelSize, display: geometry)
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
                    motd: "Native screen capture on \(host)",
                    pairId: pairId))
            
            
            onConnected?()
        }
    }

    nonisolated func connectorDidDisconnect(_ connector: TrayFollowerConnector, reason: String) {
        Task { @MainActor [weak self] in
            self?.sendData = nil
            self?.stopAllCaptures()
        }
    }

    nonisolated func connector(_ connector: TrayFollowerConnector, isReconnecting attempt: Int) {}

    nonisolated func connector(_ connector: TrayFollowerConnector, didGiveUp lastError: String) {
        Task { @MainActor [weak self] in
            self?.teardownConnection()
            self?.onGaveUp?(lastError)
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
