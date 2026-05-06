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
    /// development chat workload. Thinking-capable models (Gemma 4, Qwen
    /// 3.6) routinely burn 4–6k reasoning tokens before any user-visible
    /// content emits, and tool-call rounds add more on top — anything
    /// below ~16k clips at `finish_reason: length`.
    static let defaultMaxTokens = 32_768

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
            // A previous Sliccstart that crashed or was force-killed
            // can leave its SwiftLM child reparented to launchd, still
            // bound to 5413 (Cmd-Q triggers `applicationWillTerminate`
            // and a clean SIGTERM, but `kill -9` / panics don't).
            // Try to reclaim the port — but only if the holding process
            // is verifiably our own installed SwiftLM binary, never an
            // unrelated app that happens to use 5413.
            let reclaimedAny = Self.reclaimOurOrphans(
                onPort: swiftLMPort,
                ourBinaryPath: installer.binaryURL.path
            )
            if reclaimedAny {
                // Give the kernel a beat to release the socket; SIGTERM
                // returns immediately but the listening socket can sit
                // in TIME_WAIT/CLOSE for a moment.
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
            if Self.isPortInUse(swiftLMPort) {
                throw LaunchError.portInUse(swiftLMPort)
            }
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

        // Resolve --ctx-size against the user's preference, the model's
        // declared maximum, and a 75 %-of-RAM ceiling derived from the
        // model's per-token KV-cache footprint. See `ContextWindowPolicy`
        // for the math; the cap exists because passing the model's full
        // 262K window for Qwen 3.6 35B caused a 120 GB peak resident on
        // a 128 GB Mac, swap-thrashing the user's machine.
        let userChoice = UserDefaults.standard.integer(forKey: swiftLMContextSizeKey)
        let modelWeightsBytes = Self.estimatedModelWeightsBytes(forRepoId: model)
        let contextSize = ContextWindowPolicy.resolve(
            userChoice: userChoice,
            modelMaxContext: capabilities.maxContextSize,
            perTokenKVBytes: ContextWindowPolicy.perTokenKVBytes(capabilities),
            physicalMemoryBytes: ProcessInfo.processInfo.physicalMemory,
            modelWeightsBytes: modelWeightsBytes
        )
        log.info(
            "start: \(model, privacy: .public) ctx=\(contextSize) (userChoice=\(userChoice), modelMax=\(capabilities.maxContextSize ?? -1)) vision=\(capabilities.supportsVision)"
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

    /// Estimate of the on-disk weight footprint for `repoId`, used as
    /// the "weights" term in `ContextWindowPolicy.resolve`. We prefer
    /// the actual cached size on disk (HF snapshot folder) when the
    /// model is installed; otherwise fall back to the catalog hint
    /// (`SuggestedModel.approxSizeGB`); otherwise zero.
    ///
    /// The estimate doesn't have to be accurate to the byte — it's
    /// subtracted from the 75 %-of-RAM budget before computing the KV
    /// ceiling, so getting it within a few GB is enough.
    static func estimatedModelWeightsBytes(forRepoId repoId: String) -> UInt64 {
        for installed in HFCache.listInstalled() where installed.repoId == repoId {
            return UInt64(max(0, installed.sizeBytes))
        }
        if let suggested = SuggestedModels.all.first(where: { $0.repoId == repoId }) {
            return UInt64(suggested.approxSizeGB * Double(1 << 30))
        }
        return 0
    }

    // MARK: - Orphan reclaim

    /// Resolve the executable path for a running PID via `proc_pidpath`.
    /// Returns `nil` if the process isn't ours to inspect, doesn't exist
    /// any more, or the syscall fails — every "no" maps to "don't kill",
    /// which is the safe default. Internal so tests can pin the predicate.
    static func executablePath(forPID pid: pid_t) -> String? {
        // PROC_PIDPATHINFO_MAXSIZE is 4 * MAXPATHLEN. Use a slightly
        // larger buffer to dodge any OS rev that bumps the constant.
        let bufSize = 4 * Int(MAXPATHLEN)
        var buf = [Int8](repeating: 0, count: bufSize)
        let written = proc_pidpath(pid, &buf, UInt32(bufSize))
        guard written > 0 else { return nil }
        return String(cString: buf)
    }

    /// PIDs of TCP processes listening on `port` on loopback. Shells out
    /// to `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` because there's no
    /// public API for "who owns this socket" on macOS that doesn't
    /// require root or special entitlements. `-Fp` prints exactly one
    /// line per match, in the form `p<pid>`, which is trivial to parse.
    static func pidsListening(onPort port: UInt16) -> [pid_t] {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        proc.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fp"]
        let stdout = Pipe()
        proc.standardOutput = stdout
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return []
        }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        guard let raw = String(data: data, encoding: .utf8) else { return [] }
        return raw
            .split(whereSeparator: \.isNewline)
            .compactMap { line -> pid_t? in
                guard line.first == "p" else { return nil }
                return pid_t(line.dropFirst())
            }
    }

    /// Decide whether `pid` is one of our orphaned SwiftLM children that
    /// we're allowed to terminate. The predicate is intentionally narrow:
    /// the executable path on disk must match our installer's
    /// `binaryURL.path` byte-for-byte. That covers every SwiftLM Sliccstart
    /// itself launched (since both go through `SwiftLMInstaller`), and
    /// nothing else — a third-party binary called "SwiftLM", a different
    /// install rooted under a different `~/.slicc`, or any unrelated app
    /// that happens to bind 5413 (foreman, a dev server, etc.) all
    /// reject and stay alive.
    static func isOurOrphanedSwiftLM(pid: pid_t, ourBinaryPath: String) -> Bool {
        guard !ourBinaryPath.isEmpty else { return false }
        guard let actual = executablePath(forPID: pid) else { return false }
        return actual == ourBinaryPath
    }

    /// SIGTERM `pid`, wait up to ~1 s for it to exit, then SIGKILL if
    /// still alive. Returns true if the process is gone by the time we
    /// return. Caller is expected to have already verified ownership
    /// via `isOurOrphanedSwiftLM`.
    @discardableResult
    static func terminateOurOrphan(pid: pid_t) -> Bool {
        kill(pid, SIGTERM)
        for _ in 0..<10 {
            if kill(pid, 0) != 0 { return true }   // ESRCH → gone
            usleep(100_000)                        // 100 ms
        }
        // Still alive → escalate. SwiftLM can be slow to drain in-flight
        // requests on a loaded model; SIGKILL is the right answer for
        // an already-orphaned instance the user has decided to replace.
        kill(pid, SIGKILL)
        usleep(200_000)
        return kill(pid, 0) != 0
    }

    /// Sweep `port` for SwiftLM children that match `ourBinaryPath`,
    /// terminating each. Returns true if at least one was reclaimed.
    /// Anything we don't own — or anything we couldn't identify — is
    /// left alone; the caller's port-in-use error path then surfaces
    /// to the user so they can sort it out by hand.
    static func reclaimOurOrphans(onPort port: UInt16, ourBinaryPath: String) -> Bool {
        let pids = pidsListening(onPort: port)
        var reclaimed = false
        for pid in pids {
            guard isOurOrphanedSwiftLM(pid: pid, ourBinaryPath: ourBinaryPath) else {
                log.info("reclaim: skipping pid=\(pid) on port \(port) — not our SwiftLM")
                continue
            }
            log.info("reclaim: terminating orphan SwiftLM pid=\(pid) on port \(port)")
            if terminateOurOrphan(pid: pid) {
                reclaimed = true
            }
        }
        return reclaimed
    }
}
