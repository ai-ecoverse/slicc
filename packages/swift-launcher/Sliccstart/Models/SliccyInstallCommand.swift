import Darwin
import Foundation

/// Bounded, cancellable commands. No shell, inherited stdin, or output pipes.
/// A lock serializes launch/cancel/timeout so cancellation cannot miss launch.
final class SliccyInstallCommand: @unchecked Sendable {
    private let process = Process()
    private let lock = NSLock()
    private var cancelled = false
    private var timedOut = false
    private let executable: String
    private let timeout: TimeInterval

    init(_ executable: String, arguments: [String], timeout: TimeInterval = 90) {
        self.executable = executable
        self.timeout = timeout
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
    }

    static func run(_ executable: String, arguments: [String]) async throws {
        try await SliccyInstallCommand(executable, arguments: arguments).execute()
    }

    func execute() async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                defer { lock.unlock() }
                guard !cancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                process.terminationHandler = { [self] process in
                    process.terminationHandler = nil
                    let error: Error? = lock.withLock {
                        if cancelled { return CancellationError() }
                        if timedOut { return SliccyInstallError.commandTimedOut(URL(fileURLWithPath: executable).lastPathComponent) }
                        if process.terminationStatus != 0 {
                            return SliccyInstallError.commandFailed(URL(fileURLWithPath: executable).lastPathComponent)
                        }
                        return nil
                    }
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
                do {
                    try process.run()
                    DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in self?.stop(timedOut: true) }
                } catch {
                    process.terminationHandler = nil
                    continuation.resume(throwing: error)
                }
            }
        } onCancel: {
            self.stop(timedOut: false)
        }
    }

    private func stop(timedOut: Bool) {
        lock.withLock {
            if timedOut { self.timedOut = true } else { cancelled = true }
            guard process.isRunning else { return }
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                self.lock.withLock {
                    if self.process.isRunning { kill(self.process.processIdentifier, SIGKILL) }
                }
            }
        }
    }
}
