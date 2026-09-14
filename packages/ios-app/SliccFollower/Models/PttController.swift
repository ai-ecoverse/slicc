import Foundation





struct PttEvent: Equatable {
    enum Kind: Equatable {
        
        case commit(String)
        
        
        case quickTap
    }

    let id: UUID
    let kind: Kind

    init(_ kind: Kind) {
        id = UUID()
        self.kind = kind
    }
}






enum PttStage: Equatable {
    case idle
    
    case enable
    
    case prompting
    
    
    
    case denied(message: String?)
    case recording
    
    case finalizing
}





protocol PttScheduling {
    func schedule(afterMs: Int, _ work: @escaping @MainActor () -> Void) -> () -> Void
}

struct MainQueuePttScheduler: PttScheduling {
    func schedule(afterMs: Int, _ work: @escaping @MainActor () -> Void) -> () -> Void {
        let item = DispatchWorkItem {
            Task { @MainActor in work() }
        }
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(afterMs), execute: item)
        return { item.cancel() }
    }
}












@MainActor
final class PttController: ObservableObject {
    
    static let engageMs = 400
    
    static let holdToEnableMs = 1000
    
    static let captionMaxWords = 8

    @Published private(set) var stage: PttStage = .idle
    
    
    @Published private(set) var caption = ""
    @Published private(set) var captionIsError = false
    
    
    
    
    
    
    @Published private(set) var event: PttEvent?

    var engineStatusLine: String { engine.statusLine }

    private let engine: DictationEngine
    private let scheduler: PttScheduling
    
    
    private let permissionTimeoutMs: Int
    
    private let finalizeTimeoutMs: Int
    private let prepareForRecording: @MainActor () -> Void

    private var pressed = false
    
    private var token = 0
    private var cancelEngage: (() -> Void)?
    private var cancelEnable: (() -> Void)?
    private var session: DictationSession?
    
    
    
    
    
    
    private var startHandle: StartHandle?

    
    
    private final class StartHandle {
        let task: Task<DictationSession?, Never>
        init(_ task: Task<DictationSession?, Never>) { self.task = task }
    }

    init(
        engine: DictationEngine,
        scheduler: PttScheduling = MainQueuePttScheduler(),
        permissionTimeoutMs: Int = 10_000,
        finalizeTimeoutMs: Int = 45_000,
        prepareForRecording: @escaping @MainActor () -> Void = {}
    ) {
        self.engine = engine
        self.scheduler = scheduler
        self.permissionTimeoutMs = permissionTimeoutMs
        self.finalizeTimeoutMs = finalizeTimeoutMs
        self.prepareForRecording = prepareForRecording
    }

    

    func pressDown() {
        guard !pressed, stage == .idle else { return }
        pressed = true
        token += 1
        let t = token
        cancelEngage = scheduler.schedule(afterMs: Self.engageMs) { [weak self] in
            guard let self else { return }
            self.cancelEngage = nil
            self.engaged(t)
        }
    }

    func pressUp() {
        guard pressed else { return }
        pressed = false
        if let cancel = cancelEngage {
            
            
            cancel()
            cancelEngage = nil
            token += 1
            event = PttEvent(.quickTap)
            return
        }
        switch stage {
        case .enable:
            cancelEnable?()
            cancelEnable = nil
            reset()
        case .prompting:
            
            
            break
        case .recording:
            finalize()
        default:
            reset()
        }
    }

    
    
    func pressCancelled() {
        guard pressed else { return }
        pressed = false
        cancelEngage?()
        cancelEngage = nil
        cancelEnable?()
        cancelEnable = nil
        session?.cancel()
        session = nil
        cancelPendingStart()
        if case .prompting = stage { return }
        reset()
    }

    

    private func engaged(_ t: Int) {
        guard pressed, t == token else { return }
        switch engine.permission {
        case .granted:
            startRecording(t)
        case .denied:
            stage = .denied(message: nil)
        case .restricted:
            stage = .denied(message: Self.restrictedMessage)
        case .undetermined:
            stage = .enable
            cancelEnable = scheduler.schedule(afterMs: Self.holdToEnableMs) { [weak self] in
                guard let self else { return }
                self.cancelEnable = nil
                self.holdComplete(t)
            }
        }
    }

    private func holdComplete(_ t: Int) {
        guard pressed, t == token, stage == .enable else { return }
        stage = .prompting
        let timeoutMs = permissionTimeoutMs
        Task { @MainActor [weak self] in
            guard let engine = self?.engine else { return }
            let outcome: DictationPermission? = await Self.withTimeout(
                ms: timeoutMs, fallback: nil
            ) {
                await engine.requestPermission()
            }
            guard let self, t == self.token else { return }
            switch outcome {
            case .granted:
                if self.pressed {
                    self.startRecording(t)
                } else {
                    
                    
                    self.reset()
                }
            case .restricted:
                if self.pressed {
                    self.stage = .denied(message: Self.restrictedMessage)
                } else {
                    self.reset()
                }
            case .denied, .undetermined:
                if self.pressed {
                    self.stage = .denied(message: nil)
                } else {
                    self.reset()
                }
            case nil:
                
                
                if self.pressed {
                    self.stage = .denied(
                        message: "The microphone didn't respond. Check Settings, then hold again.")
                } else {
                    self.reset()
                }
            }
        }
    }

    private func startRecording(_ t: Int) {
        prepareForRecording()
        stage = .recording
        caption = ""
        captionIsError = false
        let engine = engine
        let task = Task<DictationSession?, Never> { @MainActor [weak self] in
            do {
                return try await engine.start(
                    onPartial: { [weak self] text in
                        guard let self, t == self.token else { return }
                        self.caption = Self.trailingWords(text)
                        self.captionIsError = false
                    },
                    onError: { [weak self] message in
                        guard let self, t == self.token else { return }
                        self.caption = message
                        self.captionIsError = true
                    })
            } catch {
                if let self, t == self.token {
                    self.caption = error.localizedDescription
                    self.captionIsError = true
                }
                return nil
            }
        }
        let handle = StartHandle(task)
        startHandle = handle
        Task { @MainActor [weak self] in
            let session = await task.value
            guard let self else {
                session?.cancel()
                return
            }
            
            
            
            guard self.startHandle === handle else { return }
            self.startHandle = nil
            guard t == self.token, self.stage == .recording else {
                session?.cancel()
                return
            }
            self.session = session
        }
    }

    private func finalize() {
        let t = token
        let live = session
        session = nil
        let pending = startHandle
        startHandle = nil
        guard live != nil || pending != nil else {
            
            reset()
            event = PttEvent(.quickTap)
            return
        }
        stage = .finalizing
        caption = "Transcribing…"
        captionIsError = false
        let timeoutMs = finalizeTimeoutMs
        Task { @MainActor [weak self] in
            let text = await Self.withTimeout(ms: timeoutMs, fallback: "") {
                if let live { return await live.stop() }
                guard let session = await pending?.task.value else { return "" }
                return await session.stop()
            }
            guard let self, t == self.token else { return }
            self.reset()
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                
                self.event = PttEvent(.quickTap)
            } else {
                self.event = PttEvent(.commit(trimmed))
            }
        }
    }

    private func cancelPendingStart() {
        guard let pending = startHandle else { return }
        startHandle = nil
        Task { @MainActor in
            (await pending.task.value)?.cancel()
        }
    }

    private func reset() {
        stage = .idle
        caption = ""
        captionIsError = false
        token += 1
    }

    #if DEBUG
        
        
        
        
        func forceStage(_ stage: PttStage, caption: String = "") {
            self.stage = stage
            self.caption = caption
        }
    #endif

    

    static let restrictedMessage =
        "Speech recognition is restricted on this device (Screen Time or a profile), "
        + "so push to talk is unavailable."

    
    static func trailingWords(_ text: String) -> String {
        let words = text.split(whereSeparator: \.isWhitespace)
        return words.suffix(captionMaxWords).joined(separator: " ")
    }

    
    
    
    
    
    
    
    
    
    
    
    private static func withTimeout<T: Sendable>(
        ms: Int,
        fallback: T,
        operation: @escaping @MainActor @Sendable () async -> T
    ) async -> T {
        await withCheckedContinuation { (continuation: CheckedContinuation<T, Never>) in
            let gate = ResumeOnceGate(continuation)
            Task { @MainActor in
                gate.resume(await operation())
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                gate.resume(fallback)
            }
        }
    }

    
    
    @MainActor
    private final class ResumeOnceGate<T: Sendable> {
        private var continuation: CheckedContinuation<T, Never>?

        init(_ continuation: CheckedContinuation<T, Never>) {
            self.continuation = continuation
        }

        func resume(_ value: T) {
            continuation?.resume(returning: value)
            continuation = nil
        }
    }
}
