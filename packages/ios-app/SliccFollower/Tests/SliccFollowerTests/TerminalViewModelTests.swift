import Foundation
import GhosttyTerminal
import XCTest

@testable import SliccFollower

@MainActor
final class TerminalViewModelTests: XCTestCase {
    private final class Recorder {
        var commands: [String] = []
        var environments: [[String: String]] = []
        var chunks: [TerminalClient.OutputChunk] = []
        var result = TerminalClient.RunResult(
            chunks: [], exitCode: 0, signal: nil, error: nil)

        func run(
            command: String,
            environment: [String: String],
            onChunk: @escaping (TerminalClient.OutputChunk) -> Void
        ) async throws -> TerminalClient.RunResult {
            commands.append(command)
            environments.append(environment)
            for chunk in chunks { onChunk(chunk) }
            return result
        }
    }

    private final class SuspendedRun {
        var continuation: CheckedContinuation<TerminalClient.RunResult, Error>?
        var cancelCount = 0
        var runCount = 0

        func run() async throws -> TerminalClient.RunResult {
            runCount += 1
            return try await withCheckedThrowingContinuation { continuation = $0 }
        }

        func cancel() -> Bool {
            guard continuation != nil else { return false }
            cancelCount += 1
            return true
        }

        func acknowledgeCancellation() {
            guard let continuation else { return }
            self.continuation = nil
            continuation.resume(throwing: TerminalClient.TerminalError.cancelled)
        }

        func complete() {
            guard let continuation else { return }
            self.continuation = nil
            continuation.resume(
                returning: TerminalClient.RunResult(
                    chunks: [], exitCode: 0, signal: nil, error: nil))
        }
    }

    private func model(_ recorder: Recorder) -> TerminalViewModel {
        TerminalViewModel(
            runCommand: { command, environment, onChunk in
                try await recorder.run(
                    command: command, environment: environment, onChunk: onChunk)
            },
            cancelCommand: { false }
        )
    }

    private func waitUntilIdle(_ model: TerminalViewModel) async {
        for _ in 0..<100 where model.isRunning { await Task.yield() }
    }

    func testLineEditingRunsCommandWithLatestGridEnvironment() async {
        let recorder = Recorder()
        recorder.chunks = [
            TerminalClient.OutputChunk(stream: .stdout, data: Data("done\r\n".utf8))
        ]
        let model = model(recorder)
        model.setConnectionAvailable(true)
        model.handleResize(InMemoryTerminalViewport(columns: 92, rows: 31))

        model.receiveInput(Data("echo hellp".utf8))
        model.receiveInput(Data([0x7F]))
        model.receiveInput(Data("o\r".utf8))
        await waitUntilIdle(model)

        XCTAssertEqual(recorder.commands, ["echo hello"])
        XCTAssertEqual(recorder.environments.first?["TERM"], "xterm-256color")
        XCTAssertEqual(recorder.environments.first?["COLUMNS"], "92")
        XCTAssertEqual(recorder.environments.first?["LINES"], "31")
        XCTAssertTrue(model.accessibilityTranscript.contains("done"))
        XCTAssertTrue(model.accessibilityTranscript.hasSuffix(TerminalViewModel.prompt))
    }

    func testBackspaceErasesASCIIAndWideGraphemeDisplayWidths() async {
        let recorder = Recorder()
        let model = model(recorder)
        model.setConnectionAvailable(true)

        model.receiveInput(Data("A界".utf8))
        model.receiveInput(Data([0x7F]))
        XCTAssertEqual(Array(model.transcriptData.suffix(6)), [0x08, 0x08, 0x20, 0x20, 0x08, 0x08])

        model.receiveInput(Data("B".utf8))
        model.receiveInput(Data([0x7F]))
        XCTAssertEqual(Array(model.transcriptData.suffix(3)), [0x08, 0x20, 0x08])

        model.receiveInput(Data("C\r".utf8))
        await waitUntilIdle(model)
        XCTAssertEqual(recorder.commands, ["AC"])
    }

    func testBackspaceTreatsCombiningAndZWJGraphemesAsSingleGlyphs() {
        let recorder = Recorder()
        let model = model(recorder)
        model.setConnectionAvailable(true)

        model.receiveInput(Data("e\u{301}👩‍💻".utf8))
        model.receiveInput(Data([0x7F]))
        XCTAssertEqual(Array(model.transcriptData.suffix(6)), [0x08, 0x08, 0x20, 0x20, 0x08, 0x08])

        model.receiveInput(Data([0x7F]))
        XCTAssertEqual(Array(model.transcriptData.suffix(3)), [0x08, 0x20, 0x08])
    }

    func testMultilinePasteRunsEveryCommandInOrder() async {
        let recorder = Recorder()
        let model = model(recorder)
        model.setConnectionAvailable(true)

        model.receiveInput(Data("echo first\necho second\n".utf8))
        await waitUntilIdle(model)

        XCTAssertEqual(recorder.commands, ["echo first", "echo second"])
        XCTAssertTrue(model.accessibilityTranscript.contains("echo first"))
        XCTAssertTrue(model.accessibilityTranscript.contains("echo second"))
        XCTAssertTrue(model.accessibilityTranscript.hasSuffix(TerminalViewModel.prompt))
    }

    func testOutputChunksReachTranscriptWithoutUtf8BoundaryCorruption() async {
        let recorder = Recorder()
        recorder.chunks = [
            TerminalClient.OutputChunk(stream: .stdout, data: Data([0xC3])),
            TerminalClient.OutputChunk(stream: .stdout, data: Data([0xA9])),
        ]
        let model = model(recorder)
        model.setConnectionAvailable(true)

        model.receiveInput(Data("printf value\r".utf8))
        await waitUntilIdle(model)

        XCTAssertNotNil(model.transcriptData.range(of: Data([0xC3, 0xA9])))
        XCTAssertTrue(model.accessibilityTranscript.contains("é"))
    }

    func testProgressCarriageReturnsStayLoneUntilPromptAdvancesLine() async {
        let recorder = Recorder()
        recorder.chunks = [
            TerminalClient.OutputChunk(stream: .stdout, data: Data("50%\r75%\r".utf8))
        ]
        let model = model(recorder)
        model.setConnectionAvailable(true)

        model.receiveInput(Data("progress\r".utf8))
        await waitUntilIdle(model)

        XCTAssertTrue(
            model.accessibilityTranscript.hasSuffix("50%\r75%\r\n\(TerminalViewModel.prompt)"))
    }

    func testSplitCRLFOutputIsNotDoubledBeforePrompt() async {
        let recorder = Recorder()
        recorder.chunks = [
            TerminalClient.OutputChunk(stream: .stdout, data: Data("done\r".utf8)),
            TerminalClient.OutputChunk(stream: .stdout, data: Data("\n".utf8)),
        ]
        let model = model(recorder)
        model.setConnectionAvailable(true)

        model.receiveInput(Data("work\r".utf8))
        await waitUntilIdle(model)

        XCTAssertTrue(
            model.accessibilityTranscript.hasSuffix("done\r\n\(TerminalViewModel.prompt)"))
    }

    func testNonzeroExitAndLeaderErrorAreVisible() async {
        let recorder = Recorder()
        recorder.result = TerminalClient.RunResult(
            chunks: [], exitCode: 127, signal: nil, error: "command not found")
        let model = model(recorder)
        model.setConnectionAvailable(true)

        model.receiveInput(Data("missing\r".utf8))
        await waitUntilIdle(model)

        XCTAssertTrue(model.accessibilityTranscript.contains("error: command not found"))
        XCTAssertTrue(model.accessibilityTranscript.contains("[exit 127]"))
    }

    func testCtrlCQueuesNextCommandUntilLeaderAcknowledgesCancellation() async {
        let suspended = SuspendedRun()
        let model = TerminalViewModel(
            runCommand: { _, _, _ in try await suspended.run() },
            cancelCommand: { suspended.cancel() }
        )
        model.setConnectionAvailable(true)
        model.receiveInput(Data("sleep 30\r".utf8))
        for _ in 0..<100 where suspended.continuation == nil { await Task.yield() }
        XCTAssertTrue(model.isRunning)
        XCTAssertNotNil(suspended.continuation)

        model.receiveInput(Data([0x03]))
        model.receiveInput(Data("echo after\r".utf8))
        await Task.yield()

        XCTAssertEqual(suspended.cancelCount, 1)
        XCTAssertEqual(suspended.runCount, 1)
        XCTAssertTrue(model.isRunning)
        XCTAssertTrue(model.accessibilityTranscript.contains("^C"))
        XCTAssertFalse(model.accessibilityTranscript.hasSuffix(TerminalViewModel.prompt))

        suspended.acknowledgeCancellation()
        for _ in 0..<100 where suspended.runCount < 2 { await Task.yield() }
        XCTAssertEqual(suspended.runCount, 2)
        XCTAssertTrue(model.isRunning)

        suspended.complete()
        await waitUntilIdle(model)
        XCTAssertTrue(model.accessibilityTranscript.contains("echo after"))
        XCTAssertTrue(model.accessibilityTranscript.hasSuffix(TerminalViewModel.prompt))
    }

    func testLeaderStallKeepsRunningCommandAlive() async {
        let suspended = SuspendedRun()
        let model = TerminalViewModel(
            runCommand: { _, _, _ in try await suspended.run() },
            cancelCommand: { suspended.cancel() }
        )
        model.setConnectionAvailable(true)
        model.receiveInput(Data("long-running build\r".utf8))
        for _ in 0..<100 where suspended.continuation == nil { await Task.yield() }

        model.setConnectionAvailable(
            WorkbenchHost.terminalConnectionAvailable(
                connectionState: .connected, isLeaderStalled: true,
                leaderCapabilities: TraySyncCapabilities(exec: true)))
        await Task.yield()

        XCTAssertTrue(model.isRunning)
        XCTAssertEqual(suspended.cancelCount, 0)
        model.setConnectionAvailable(false)
        await waitUntilIdle(model)
    }

    func testDisconnectedInputDoesNotRunOrEcho() async {
        let recorder = Recorder()
        let model = model(recorder)

        model.receiveInput(Data("echo hidden\r".utf8))
        await Task.yield()

        XCTAssertTrue(recorder.commands.isEmpty)
        XCTAssertTrue(model.transcriptData.isEmpty)
    }

    func testRunningBarOnlyAppearsWhileTerminalIsActive() {
        XCTAssertTrue(
            TerminalView.shouldShowRunningBar(
                isRunning: true, connectionAvailable: true, isActive: true))
        XCTAssertFalse(
            TerminalView.shouldShowRunningBar(
                isRunning: true, connectionAvailable: true, isActive: false))
        XCTAssertFalse(
            TerminalView.shouldShowRunningBar(
                isRunning: true, connectionAvailable: false, isActive: true))
        XCTAssertFalse(
            TerminalView.shouldShowRunningBar(
                isRunning: false, connectionAvailable: true, isActive: true))
    }

    func testTerminalAvailabilityRequiresLeaderExecCapability() {
        XCTAssertTrue(
            WorkbenchHost.terminalConnectionAvailable(
                connectionState: .connected, isLeaderStalled: false,
                leaderCapabilities: TraySyncCapabilities(exec: true)))
        XCTAssertFalse(
            WorkbenchHost.terminalConnectionAvailable(
                connectionState: .connected, isLeaderStalled: false,
                leaderCapabilities: TraySyncCapabilities(exec: false)))
        XCTAssertFalse(
            WorkbenchHost.terminalConnectionAvailable(
                connectionState: .connected, isLeaderStalled: false,
                leaderCapabilities: nil))
    }

    func testUnavailableTerminalDistinguishesDisconnectFromUnsupportedLeader() {
        XCTAssertEqual(
            TerminalView.unavailableState(transportConnected: false),
            .disconnected)
        XCTAssertEqual(
            TerminalView.unavailableState(transportConnected: true),
            .unsupported)
        XCTAssertTrue(
            TerminalView.UnavailableState.unsupported.message.localizedCaseInsensitiveContains(
                "upgrade"))
    }

    func testTerminalAccessibilityRequiresConnectionAndActiveSurface() {
        XCTAssertTrue(
            TerminalView.shouldExposeTerminalAccessibility(
                connectionAvailable: true, isActive: true))
        XCTAssertFalse(
            TerminalView.shouldExposeTerminalAccessibility(
                connectionAvailable: false, isActive: true))
        XCTAssertFalse(
            TerminalView.shouldExposeTerminalAccessibility(
                connectionAvailable: true, isActive: false))
    }
}
