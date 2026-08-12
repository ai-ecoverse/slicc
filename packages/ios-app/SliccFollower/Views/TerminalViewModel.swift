import Foundation
import GhosttyTerminal
import SwiftUI

@MainActor
final class TerminalViewModel: ObservableObject {
    typealias RunCommand =
        @MainActor (
            _ command: String,
            _ environment: [String: String],
            _ onChunk: @escaping (TerminalClient.OutputChunk) -> Void
        ) async throws -> TerminalClient.RunResult
    typealias CancelCommand = @MainActor () -> Bool

    static let prompt = "slicc$ "
    static let inputEchoBatchLimit = 4 * 1_024
    private static let transcriptLimit = 64 * 1_024

    let terminal = TerminalViewState()
    private(set) lazy var session = InMemoryTerminalSession(
        write: { [weak self] data in
            Task { @MainActor [weak self] in self?.receiveInput(data) }
        },
        resize: { [weak self] viewport in
            Task { @MainActor [weak self] in self?.handleResize(viewport) }
        }
    )

    @Published private(set) var isRunning = false
    @Published private(set) var accessibilityTranscript = ""
    private(set) var transcriptData = Data()
    private(set) var lastViewport: InMemoryTerminalViewport?

    private let runCommand: RunCommand
    private let cancelCommand: CancelCommand
    private var input = ""
    private var pendingUTF8 = Data()
    private var queuedInput = Data()
    private var runTask: Task<Void, Never>?
    private var connectionAvailable = false
    private var didStart = false
    private var isStarting = false
    private var escapeState = 0
    private var lastRenderedByte: UInt8?
    /// Applied to everything the surface renders, so leader output that
    /// arrives pipe-style (bare LF) does not stair-step down the screen.
    private var lineEndings = TerminalLineEndings()

    init(runCommand: @escaping RunCommand, cancelCommand: @escaping CancelCommand) {
        self.runCommand = runCommand
        self.cancelCommand = cancelCommand
        terminal.configuration = TerminalSurfaceOptions(backend: .inMemory(session))
    }

    convenience init(client: TerminalClient, fixtureEnabled: Bool = false) {
        #if DEBUG
            if fixtureEnabled {
                self.init(
                    runCommand: { command, _, onChunk in
                        let data = Data("fixture output: \(command)\r\n".utf8)
                        let chunk = TerminalClient.OutputChunk(stream: .stdout, data: data)
                        onChunk(chunk)
                        return TerminalClient.RunResult(
                            chunks: [chunk], exitCode: 0, signal: nil, error: nil)
                    },
                    cancelCommand: { false }
                )
                return
            }
        #endif
        self.init(
            runCommand: { command, environment, onChunk in
                try await client.run(command: command, env: environment, onChunk: onChunk)
            },
            cancelCommand: { client.cancel() }
        )
    }

    func start() async {
        guard !didStart, !isStarting else { return }
        isStarting = true
        defer { isStarting = false }
        while terminal.surface == nil, !Task.isCancelled {
            await Task.yield()
        }
        guard !Task.isCancelled, !didStart else { return }
        didStart = true
        emit(Data("Sliccy leader terminal\r\n\(Self.prompt)".utf8))
    }

    func setConnectionAvailable(_ available: Bool) {
        connectionAvailable = available
        if !available { queuedInput.removeAll(keepingCapacity: true) }
        if !available, isRunning {
            let cancelledClient = cancelCommand()
            runTask?.cancel()
            if !cancelledClient { showPrompt() }
        }
    }

    func applyTheme(_ theme: SliccTheme?, systemScheme: ColorScheme) {
        let defaults =
            systemScheme == .dark
            ? (background: "0F0F1A", foreground: "FFFFFF", accent: "7155FA")
            : (background: "FFFFFF", foreground: "0A0A0A", accent: "7155FA")
        let background = hexToken("--canvas", from: theme) ?? defaults.background
        let foreground = hexToken("--ink", from: theme) ?? defaults.foreground
        let accent = hexToken("--ctx", from: theme) ?? defaults.accent
        let configuration = TerminalConfiguration { builder in
            builder.withBackground(background)
            builder.withForeground(foreground)
            builder.withCursorColor(accent)
            builder.withSelectionBackground(accent)
            builder.withWindowPaddingX(8)
            builder.withWindowPaddingY(8)
        }
        terminal.setTheme(TerminalTheme(light: configuration, dark: configuration))
    }

    func receiveInput(_ data: Data) {
        guard connectionAvailable else { return }
        var echoBuffer = Data()
        for byte in data { consume(byte, echoBuffer: &echoBuffer) }
        flushEcho(&echoBuffer)
    }

    func handleResize(_ viewport: InMemoryTerminalViewport) {
        lastViewport = viewport
    }

    func interrupt() {
        guard connectionAvailable else { return }
        input = ""
        pendingUTF8.removeAll(keepingCapacity: true)
        queuedInput.removeAll(keepingCapacity: true)
        emit(Data("^C\r\n".utf8))
        let cancelledClient = cancelCommand()
        runTask?.cancel()
        if !cancelledClient { showPrompt() }
    }

    private func consume(_ byte: UInt8, echoBuffer: inout Data) {
        if isRunning {
            if byte == 0x03 { interrupt() } else { queuedInput.append(byte) }
            return
        }
        if consumeEscape(byte) { return }
        switch byte {
        case 0x03:
            flushEcho(&echoBuffer)
            interrupt()
        case 0x08, 0x7F:
            flushEcho(&echoBuffer)
            deleteBackward()
        case 0x0A, 0x0D:
            flushEcho(&echoBuffer)
            submitInput()
        case 0x1B:
            escapeState = 1
        case 0x20...0xFF where !isRunning:
            pendingUTF8.append(byte)
            if let text = String(data: pendingUTF8, encoding: .utf8) {
                pendingUTF8.removeAll(keepingCapacity: true)
                input.append(text)
                echoBuffer.append(contentsOf: text.utf8)
                if echoBuffer.count >= Self.inputEchoBatchLimit { flushEcho(&echoBuffer) }
            }
        default:
            return
        }
    }

    private func flushEcho(_ buffer: inout Data) {
        guard !buffer.isEmpty else { return }
        emit(buffer)
        buffer.removeAll(keepingCapacity: true)
    }

    private func consumeEscape(_ byte: UInt8) -> Bool {
        guard escapeState != 0 else { return false }
        if escapeState == 1, byte == 0x5B {
            escapeState = 2
        } else if escapeState == 1 || (escapeState == 2 && (0x40...0x7E).contains(byte)) {
            escapeState = 0
        }
        return true
    }

    private func deleteBackward() {
        guard !isRunning, !input.isEmpty else { return }
        let width = input.removeLast().terminalDisplayWidth
        guard width > 0 else { return }
        emit(Data(repeating: 0x08, count: width))
        emit(Data(repeating: 0x20, count: width))
        emit(Data(repeating: 0x08, count: width))
    }

    private func submitInput() {
        guard !isRunning else { return }
        let command = input
        input = ""
        pendingUTF8.removeAll(keepingCapacity: true)
        emit(Data("\r\n".utf8))
        guard !command.isEmpty else {
            showPrompt()
            return
        }
        isRunning = true
        let environment = terminalEnvironment()
        runTask = Task { @MainActor [weak self] in
            await self?.execute(command, environment: environment)
        }
    }

    private func execute(_ command: String, environment: [String: String]) async {
        defer {
            isRunning = false
            runTask = nil
            drainQueuedInput()
        }
        do {
            try Task.checkCancellation()
            let result = try await runCommand(command, environment) { [weak self] chunk in
                self?.emit(chunk.data)
            }
            if let error = result.error { writeLine("error: \(error)") }
            if let signal = result.signal { writeLine("[signal \(signal)]") }
            if result.exitCode != 0 { writeLine("[exit \(result.exitCode)]") }
            showPrompt()
        } catch TerminalClient.TerminalError.cancelled {
            showPrompt()
        } catch is CancellationError {
            return
        } catch {
            writeLine("error: \(error.localizedDescription)")
            showPrompt()
        }
    }

    private func terminalEnvironment() -> [String: String] {
        var environment = ["TERM": "xterm-256color"]
        if let viewport = lastViewport {
            environment["COLUMNS"] = String(viewport.columns)
            environment["LINES"] = String(viewport.rows)
        }
        return environment
    }

    private func drainQueuedInput() {
        guard connectionAvailable, !queuedInput.isEmpty else { return }
        let queued = queuedInput
        queuedInput.removeAll(keepingCapacity: true)
        receiveInput(queued)
    }

    private func writeLine(_ text: String) {
        ensureFreshLine()
        emit(Data("\(text)\r\n".utf8))
    }

    private func showPrompt() {
        ensureFreshLine()
        emit(Data(Self.prompt.utf8))
    }

    private func ensureFreshLine() {
        guard let byte = lastRenderedByte, byte != 0x0A else { return }
        emit(byte == 0x0D ? Data([0x0A]) : Data("\r\n".utf8))
    }

    private func emit(_ raw: Data) {
        guard !raw.isEmpty else { return }
        // Normalise at the single choke point rather than at the exec-chunk
        // call site: the transcript and `lastRenderedByte` must agree with
        // what the surface actually rendered, and locally written lines are
        // already CRLF, so this is a no-op for them.
        let data = lineEndings.normalize(raw)
        session.receive(data)
        transcriptData.append(data)
        if transcriptData.count > Self.transcriptLimit {
            transcriptData.removeFirst(transcriptData.count - Self.transcriptLimit)
        }
        lastRenderedByte = data.last
        let bytes = transcriptData.map { $0 }
        // The terminal receives arbitrary bytes; accessibility needs a lossy UTF-8 mirror.
        // swiftlint:disable:next optional_data_string_conversion
        accessibilityTranscript = String(decoding: bytes, as: UTF8.self)
    }

    private func hexToken(_ name: String, from theme: SliccTheme?) -> String? {
        guard let raw = theme?.tokens[name], Color(hexToken: raw) != nil else { return nil }
        return raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
    }
}

extension Character {
    /// Ghostty renders one extended grapheme as at most two cells. Taking the
    /// widest scalar preserves combining and ZWJ sequences as one glyph.
    fileprivate var terminalDisplayWidth: Int {
        if unicodeScalars.contains(where: { $0.value == 0xFE0F }) { return 2 }
        return unicodeScalars.reduce(0) { max($0, $1.terminalCellWidth) }
    }
}

extension UnicodeScalar {
    /// Mirrors the deterministic width policy bundled with Ghostty's
    /// ShellCraftKit. That helper is internal to a product this app does not
    /// import, so the line editor keeps the scalar policy local.
    fileprivate var terminalCellWidth: Int {
        if properties.generalCategory == .control
            || properties.generalCategory == .format
            || properties.generalCategory == .nonspacingMark
            || properties.generalCategory == .enclosingMark
        {
            return 0
        }
        if properties.isEmojiPresentation { return 2 }

        switch value {
        case 0x1100...0x115F,
            0x2329...0x232A,
            0x2E80...0x2FFB,
            0x3000...0x303E,
            0x3041...0x33FF,
            0x3400...0x4DBF,
            0x4E00...0xA4C6,
            0xA960...0xA97C,
            0xAC00...0xD7A3,
            0xF900...0xFAFF,
            0xFE10...0xFE19,
            0xFE30...0xFE6B,
            0xFF01...0xFF60,
            0xFFE0...0xFFE6,
            0x20000...0x2FFFD,
            0x30000...0x3FFFD:
            return 2
        default:
            return 1
        }
    }
}
