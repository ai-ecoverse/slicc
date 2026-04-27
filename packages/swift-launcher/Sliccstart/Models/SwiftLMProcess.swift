import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "SwiftLMProcess")

/// Default port SwiftLM listens on. Matches their CLI default and is the
/// origin the webapp's `swiftlm` provider talks to.
let swiftLMPort: UInt16 = 5413

/// Manages a single SwiftLM child process serving one model.
///
/// SwiftLM loads a single model per process (their `--parallel` flag only
/// gates request concurrency, not multiple models), so this is intentionally
/// a singleton — `start(model:)` calls implicitly stop the previous model.
@Observable
final class SwiftLMProcess {
    enum State: Equatable {
        case stopped
        case starting
        case running(model: String, pid: Int32)
        case failed(String)
    }

    enum LaunchError: LocalizedError {
        case alreadyRunning
        case portInUse(UInt16)
        var errorDescription: String? {
            switch self {
            case .alreadyRunning: return "SwiftLM is already running."
            case .portInUse(let port): return "Port \(port) is already in use."
            }
        }
    }

    private(set) var state: State = .stopped
    private var process: Process?
    private let installer = SwiftLMInstaller()

    var installerState: SwiftLMInstaller.State { installer.state }

    var loadedModel: String? {
        if case .running(let model, _) = state { return model }
        return nil
    }

    var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    /// Default CLI flags. SwiftLM's defaults are tuned for short demos
    /// (`--max-tokens 2048`, no explicit ctx-size) which leaves the agent
    /// truncating long replies; we override to something useful for a
    /// development chat workload.
    static let defaultMaxTokens = 8192

    /// Floor used when a model's `config.json` doesn't declare
    /// `max_position_embeddings`. Anything we'd reasonably ship here
    /// supports at least 32k; the fallback exists only to keep the launch
    /// from failing if the probe couldn't read config.
    static let fallbackContextSize = 32_768

    /// Allowed CORS origins for the SwiftLM HTTP server. The webapp talks
    /// to localhost ports — Sliccy serves on 5710 and Electron-mode lands
    /// somewhere from 5711+ — and Chrome adds an `Origin` header for those.
    static let corsOrigin = "*"

    @MainActor
    func start(model: String) async throws {
        if isRunning {
            throw LaunchError.alreadyRunning
        }
        if Self.isPortInUse(swiftLMPort) {
            throw LaunchError.portInUse(swiftLMPort)
        }

        state = .starting
        let binary: URL
        do {
            binary = try await installer.ensureInstalled()
        } catch {
            state = .failed(error.localizedDescription)
            throw error
        }

        let proc = Process()
        proc.executableURL = binary

        // Probe the cached config.json once and use it for every flag
        // that depends on the model: vision routing, context window.
        let capabilities = ModelArchProbe.capabilities(for: model)
        let contextSize = capabilities.maxContextSize ?? Self.fallbackContextSize
        log.info(
            "start: \(model, privacy: .public) ctx=\(contextSize) vision=\(capabilities.supportsVision)"
        )

        var args: [String] = [
            "--model", model,
            "--port", "\(swiftLMPort)",
            "--host", "127.0.0.1",
            "--max-tokens", "\(Self.defaultMaxTokens)",
            // Run at the model's declared maximum context. SwiftLM's
            // sliding-window cache keeps this from blowing up RAM for
            // typical short-conversation use, and `--turbo-kv` below
            // compresses any KV history past 8k to ~3.5 bits/token so the
            // long-context paths stay viable on 32-64 GB Macs.
            "--ctx-size", "\(contextSize)",
            "--cors", Self.corsOrigin,
            // 3-bit PolarQuant + QJL KV-cache compression. SwiftLM's
            // upstream recommendation for any 100k+ context workload —
            // safely active alongside short contexts because the
            // compression only kicks in past 8 192 tokens of history.
            "--turbo-kv",
            // SwiftLM defaults --thinking off; we turn it on so reasoning
            // models (Qwen3+, Gemma 4 with tools) emit `delta.reasoning_content`
            // out of the box. Templates for non-thinking models ignore it,
            // and clients can still override per-request via
            // `chat_template_kwargs.enable_thinking`.
            "--thinking",
        ]

        // Vision-language models need --vision; without it SwiftLM loads
        // them through the text-only `LLMModelFactory` and ignores image
        // parts in OpenAI multipart content. We probe the cached config.json
        // (mirroring SwiftLM's own `ModelArchitectureProbe`) so VLMs like
        // Gemma 4 light up automatically.
        if capabilities.supportsVision {
            args.append("--vision")
        }

        proc.arguments = args
        // SwiftLM finds `mlx.metallib` next to the binary; cwd doesn't matter
        // for that, but pin it to the version directory so any relative paths
        // SwiftLM might resolve still land somewhere predictable.
        proc.currentDirectoryURL = binary.deletingLastPathComponent()

        let stdout = Pipe()
        let stderr = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stderr

        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            for l in line.split(separator: "\n", omittingEmptySubsequences: true) {
                log.info("[swiftlm] \(l, privacy: .public)")
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            for l in line.split(separator: "\n", omittingEmptySubsequences: true) {
                log.error("[swiftlm] \(l, privacy: .public)")
            }
        }

        proc.terminationHandler = { [weak self] p in
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            log.info("swiftlm exited code=\(p.terminationStatus)")
            DispatchQueue.main.async {
                self?.process = nil
                self?.state = .stopped
            }
        }

        try proc.run()
        log.info("started swiftlm pid=\(proc.processIdentifier) model=\(model, privacy: .public)")
        process = proc
        state = .running(model: model, pid: proc.processIdentifier)
    }

    func stop() {
        process?.terminate()
        process = nil
        state = .stopped
    }

    /// `connect()`-based check: returns true if anything is already
    /// listening on `port` on loopback. Mirrors `SliccProcess.isPortInUse`.
    private static func isPortInUse(_ port: UInt16) -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(sock, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }
}
