import Foundation
import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

@MainActor
final class TerminalClientTests: XCTestCase {
    private actor ManualSleeper {
        private var elapsed = false
        private var waiter: CheckedContinuation<Void, Never>?

        func sleep() async throws {
            if elapsed { return }
            await withCheckedContinuation { waiter = $0 }
            try Task.checkCancellation()
        }

        func elapse() {
            elapsed = true
            waiter?.resume()
            waiter = nil
        }
    }

    private final class Wire {
        private(set) var sent: [FollowerToLeaderMessage] = []
        var sendSucceeds = true

        func send(_ message: FollowerToLeaderMessage) -> Bool {
            sent.append(message)
            return sendSucceeds
        }

        var signals: [(requestId: String, signal: String)] {
            sent.compactMap { message in
                if case .execSignal(let requestId, let signal) = message {
                    return (requestId, signal)
                }
                return nil
            }
        }

        var responses: [(requestId: String, exitCode: Int, error: String?)] {
            sent.compactMap { message in
                if case .execResponse(let requestId, let exitCode, _, let error) = message {
                    return (requestId, exitCode, error)
                }
                return nil
            }
        }
    }

    private func makeClient(
        wire: Wire,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = {
            try await Task.sleep(nanoseconds: $0)
        }
    ) -> TerminalClient {
        TerminalClient(
            sleep: sleep,
            makeRequestId: { "req-1" },
            send: { wire.send($0) })
    }

    private func waitForRun(_ client: TerminalClient) async {
        for _ in 0..<100 where !client.isRunning {
            await Task.yield()
        }
    }

    private func encoded(_ data: Data) -> String {
        data.base64EncodedString()
    }

    func testHappyPathPreservesChunkOrderAndSplitUtf8Bytes() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        var observed: [TerminalClient.OutputChunk] = []
        let task = Task {
            try await client.run(
                command: "printf café", cwd: "/workspace", env: ["TERM": "xterm"],
                onChunk: { observed.append($0) })
        }
        await waitForRun(client)

        guard
            case .execRequest(let requestId, let command, let cwd, let env, _) = wire.sent.first
        else { return XCTFail("expected exec.request") }
        XCTAssertEqual(requestId, "req-1")
        XCTAssertEqual(command, "printf café")
        XCTAssertEqual(cwd, "/workspace")
        XCTAssertEqual(env, ["TERM": "xterm"])

        client.handleChunk(
            requestId: requestId, stream: "stdout", base64Data: encoded(Data("caf".utf8)))
        client.handleChunk(
            requestId: requestId, stream: "stdout", base64Data: encoded(Data([0xC3])))
        client.handleChunk(
            requestId: requestId, stream: "stderr", base64Data: encoded(Data("warning".utf8)))
        client.handleChunk(
            requestId: requestId, stream: "stdout", base64Data: encoded(Data([0xA9])))
        client.handleResponse(requestId: requestId, exitCode: 0, signal: nil, error: nil)

        let result = try await task.value
        XCTAssertEqual(
            result.chunks.map(\.stream), [.stdout, .stdout, .stderr, .stdout])
        XCTAssertEqual(observed, result.chunks)
        XCTAssertEqual(String(bytes: result.stdout, encoding: .utf8), "café")
        XCTAssertEqual(String(bytes: result.stderr, encoding: .utf8), "warning")
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertNil(result.error)
        XCTAssertFalse(client.isRunning)
    }

    func testRetainedResultIsBoundedWhileStreamingReceivesFullOutput() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let output = Data(repeating: 0x41, count: TerminalClient.retainedOutputLimit + 37)
        var streamed = Data()
        let task = Task {
            try await client.run(command: "large-output") { streamed.append($0.data) }
        }
        await waitForRun(client)

        client.handleChunk(
            requestId: "req-1", stream: "stdout", base64Data: encoded(output))
        client.handleResponse(requestId: "req-1", exitCode: 0, signal: nil, error: nil)
        let result = try await task.value

        XCTAssertEqual(streamed, output)
        XCTAssertEqual(result.stdout.count, TerminalClient.retainedOutputLimit)
        XCTAssertEqual(result.stdout, Data(output.suffix(TerminalClient.retainedOutputLimit)))
    }

    func testNonZeroExitIsAResult() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.run(command: "false") }
        await waitForRun(client)

        client.handleResponse(
            requestId: "req-1", exitCode: 7, signal: nil, error: nil)
        let result = try await task.value
        XCTAssertEqual(result.exitCode, 7)
        XCTAssertNil(result.error)
    }

    func testLeaderErrorIsReturnedWithTerminalStatus() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.run(command: "missing-command") }
        await waitForRun(client)

        client.handleResponse(
            requestId: "req-1", exitCode: 127, signal: nil,
            error: "exec is not supported on this leader")
        let result = try await task.value
        XCTAssertEqual(result.exitCode, 127)
        XCTAssertEqual(result.error, "exec is not supported on this leader")
    }

    func testLongRunningCommandWaitsForLeaderResponseWithoutSignal() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.run(command: "long-running build") }
        await waitForRun(client)

        try await Task.sleep(nanoseconds: 75_000_000)
        XCTAssertTrue(client.isRunning)
        XCTAssertTrue(wire.signals.isEmpty)

        client.handleResponse(requestId: "req-1", exitCode: 0, signal: nil, error: nil)
        let result = try await task.value
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertFalse(client.isRunning)
    }

    func testDefaultCommandLifetimeIgnoresElapsedLegacyDeadline() async throws {
        let wire = Wire()
        let sleeper = ManualSleeper()
        let client = makeClient(wire: wire, sleep: { _ in try await sleeper.sleep() })
        let task = Task { try await client.run(command: "long-running build") }
        await waitForRun(client)

        await sleeper.elapse()
        for _ in 0..<100 where client.isRunning {
            await Task.yield()
        }

        XCTAssertTrue(client.isRunning)
        XCTAssertTrue(wire.signals.isEmpty)
        client.handleResponse(requestId: "req-1", exitCode: 0, signal: nil, error: nil)
        let result = try await task.value
        XCTAssertEqual(result.exitCode, 0)
    }

    func testTaskCancellationWaitsForLeaderAcknowledgementBeforeNextRun() async {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.run(command: "long-running") }
        await waitForRun(client)

        task.cancel()
        await Task.yield()
        XCTAssertEqual(wire.signals.count, 1)
        XCTAssertEqual(wire.signals.first?.signal, "SIGINT")
        XCTAssertTrue(client.isRunning)
        await assertThrows(.alreadyRunning) {
            _ = try await client.run(command: "too-early")
        }

        client.handleResponse(
            requestId: "req-1", exitCode: 130, signal: "SIGINT", error: "cancelled")
        await assertThrows(.cancelled) { _ = try await task.value }
        XCTAssertFalse(client.isRunning)

        let next = Task { try await client.run(command: "after-ack") }
        await waitForRun(client)
        client.handleResponse(requestId: "req-1", exitCode: 0, signal: nil, error: nil)
        let result = try? await next.value
        XCTAssertEqual(result?.exitCode, 0)
    }

    func testDisconnectFailsInFlightRunImmediately() async {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.run(command: "waiting") }
        await waitForRun(client)

        client.disconnect()
        await assertThrows(.disconnected) { _ = try await task.value }
        XCTAssertTrue(wire.signals.isEmpty)
        XCTAssertFalse(client.isRunning)
    }

    func testStaleRequestOutputAndResponseAreIgnored() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.run(command: "active") }
        await waitForRun(client)

        client.handleChunk(
            requestId: "stale", stream: "stdout", base64Data: encoded(Data("wrong".utf8)))
        client.handleResponse(
            requestId: "stale", exitCode: 99, signal: nil, error: "wrong run")
        XCTAssertTrue(client.isRunning)

        client.handleResponse(
            requestId: "req-1", exitCode: 0, signal: nil, error: nil)
        let result = try await task.value
        XCTAssertTrue(result.chunks.isEmpty)
        XCTAssertEqual(result.exitCode, 0)
    }

    func testSecondConcurrentRunFailsWithoutSending() async {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let first = Task { try await client.run(command: "first") }
        await waitForRun(client)

        await assertThrows(.alreadyRunning) {
            _ = try await client.run(command: "second")
        }
        XCTAssertEqual(wire.sent.count, 1)
        client.disconnect()
        await assertThrows(.disconnected) { _ = try await first.value }
    }

    func testFailedSendFailsImmediately() async {
        let wire = Wire()
        wire.sendSucceeds = false
        let client = makeClient(wire: wire)

        await assertThrows(.disconnected) {
            _ = try await client.run(command: "never sent")
        }
        XCTAssertFalse(client.isRunning)
    }

    func testLeaderOriginatedRequestGetsRefused() {
        let wire = Wire()
        let client = makeClient(wire: wire)

        client.refuseLeaderRequest(requestId: "leader-1")
        XCTAssertEqual(wire.responses.count, 1)
        XCTAssertEqual(wire.responses.first?.requestId, "leader-1")
        XCTAssertEqual(wire.responses.first?.exitCode, 127)
        XCTAssertEqual(wire.responses.first?.error, "exec is not supported on this follower")
    }

    func testMalformedOutputFailsTheMatchingRun() async {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.run(command: "bad-output") }
        await waitForRun(client)

        client.handleChunk(
            requestId: "req-1", stream: "stdout", base64Data: "not base64")
        XCTAssertTrue(client.isRunning)
        XCTAssertEqual(wire.signals.count, 1)
        client.handleResponse(requestId: "req-1", exitCode: 130, signal: "SIGINT", error: nil)
        await assertThrows(.malformedChunk) { _ = try await task.value }
    }

    private func assertThrows(
        _ expected: TerminalClient.TerminalError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("expected \(expected), got success", file: file, line: line)
        } catch let error as TerminalClient.TerminalError {
            XCTAssertEqual(error, expected, file: file, line: line)
        } catch {
            XCTFail("expected \(expected), got \(error)", file: file, line: line)
        }
    }
}
