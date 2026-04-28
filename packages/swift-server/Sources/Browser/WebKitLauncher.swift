import Foundation
import Logging

/// Result of launching the WebKit process with inspector pipe.
struct WebKitProcess: @unchecked Sendable {
    /// The pid of the spawned WebKit process.
    let pid: pid_t
    /// File handle for writing to the WebKit inspector pipe (parent → WebKit).
    let pipeWrite: FileHandle
    /// File handle for reading from the WebKit inspector pipe (WebKit → parent).
    let pipeRead: FileHandle

    /// Check if the WebKit process is still running.
    var isRunning: Bool {
        kill(pid, 0) == 0
    }

    /// Send SIGKILL to the WebKit process.
    func forceKill() {
        kill(pid, SIGKILL)
    }

    /// Send SIGTERM to the WebKit process.
    func terminate() {
        kill(pid, SIGTERM)
    }
}

enum WebKitLauncherError: LocalizedError, Sendable {
    case executableNotFound
    case invalidExecutable(String)
    case pipeCreationFailed

    var errorDescription: String? {
        switch self {
        case .executableNotFound:
            return "Could not find WebKit binary. Set WEBKIT_PATH or install Playwright WebKit: npx playwright install webkit"
        case .invalidExecutable(let path):
            return "WebKit executable does not exist at \(path)."
        case .pipeCreationFailed:
            return "Failed to create inspector pipe file descriptors for WebKit."
        }
    }
}

struct WebKitLauncher: Sendable {
    private let logger: Logger
    private let fileExists: @Sendable (String) -> Bool
    private let directoryContents: @Sendable (String) throws -> [String]
    private let environmentProvider: @Sendable () -> [String: String]
    private let homeDirectoryProvider: @Sendable () -> String

    init(
        logger: Logger = Logger(label: "slicc.webkit-launcher"),
        fileExists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        directoryContents: @escaping @Sendable (String) throws -> [String] = {
            try FileManager.default.contentsOfDirectory(atPath: $0)
        },
        environmentProvider: @escaping @Sendable () -> [String: String] = { ProcessInfo.processInfo.environment },
        homeDirectoryProvider: @escaping @Sendable () -> String = {
            FileManager.default.homeDirectoryForCurrentUser.path
        }
    ) {
        self.logger = logger
        self.fileExists = fileExists
        self.directoryContents = directoryContents
        self.environmentProvider = environmentProvider
        self.homeDirectoryProvider = homeDirectoryProvider
    }

    /// Find the Playwright WebKit binary path.
    ///
    /// Resolution order:
    /// 1. `WEBKIT_PATH` environment variable (set by Sliccstart)
    /// 2. Auto-detect from `~/Library/Caches/ms-playwright/webkit-*/Playwright.app/Contents/MacOS/Playwright`
    func findWebKitExecutable() -> String? {
        let environment = environmentProvider()

        // 1. Environment variable
        if let envPath = environment["WEBKIT_PATH"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !envPath.isEmpty, fileExists(envPath) {
            return envPath
        }

        // 2. Auto-detect from Playwright cache
        let homeDir = homeDirectoryProvider()
        let cacheRoot = URL(fileURLWithPath: homeDir)
            .appendingPathComponent("Library/Caches/ms-playwright").path

        guard let entries = try? directoryContents(cacheRoot) else {
            return nil
        }

        let webkitDirs = entries
            .filter { $0.hasPrefix("webkit-") }
            .sorted { $0.localizedStandardCompare($1) == .orderedDescending }

        for dir in webkitDirs {
            let candidate = URL(fileURLWithPath: cacheRoot)
                .appendingPathComponent(dir)
                .appendingPathComponent("Playwright.app/Contents/MacOS/Playwright")
                .path
            if fileExists(candidate) {
                return candidate
            }
        }

        return nil
    }

    /// Resolve the framework directory from a WebKit binary path.
    /// For Playwright.app: Contents/MacOS/Playwright → Contents/Frameworks
    func resolveFrameworkPath(binaryPath: String) -> String {
        let macosDir = URL(fileURLWithPath: binaryPath).deletingLastPathComponent()
        let contentsDir = macosDir.deletingLastPathComponent()
        let frameworksDir = contentsDir.appendingPathComponent("Frameworks").path
        if fileExists(frameworksDir) {
            return frameworksDir
        }
        return macosDir.path
    }

    /// Launch the WebKit process with inspector pipe.
    ///
    /// Creates two Unix pipe pairs for the inspector protocol:
    /// - fd 3 (from WebKit's perspective): WebKit reads commands from parent
    /// - fd 4 (from WebKit's perspective): WebKit writes responses to parent
    ///
    /// The inspector pipe uses null-byte delimited JSON messages.
    ///
    /// Pass `startupURL` to have Playwright's MiniBrowser open a visible
    /// startup window navigated to that URL. Omit it to launch headless
    /// (no visible window) — useful for pure automation contexts.
    func launch(
        binaryPath: String,
        frameworkPath: String? = nil,
        startupURL: String? = nil
    ) throws -> WebKitProcess {
        guard fileExists(binaryPath) else {
            throw WebKitLauncherError.invalidExecutable(binaryPath)
        }

        let resolvedFrameworkPath = frameworkPath
            ?? environmentProvider()["DYLD_FRAMEWORK_PATH"]
            ?? resolveFrameworkPath(binaryPath: binaryPath)

        // Create two pipe pairs for the inspector protocol.
        // Pipe pair 1: parent writes → WebKit reads (WebKit's fd 3)
        // Pipe pair 2: WebKit writes → parent reads (WebKit's fd 4)
        var toWebKit: [Int32] = [0, 0]   // [read, write]
        var fromWebKit: [Int32] = [0, 0] // [read, write]

        guard pipe(&toWebKit) == 0, pipe(&fromWebKit) == 0 else {
            throw WebKitLauncherError.pipeCreationFailed
        }

        // Build base argv. Drop `--no-startup-window` when a startup URL is
        // given so MiniBrowser actually opens a visible window pointed at
        // the SLICC UI.
        var browserArgs: [String] = ["--inspector-pipe"]
        if let startupURL {
            browserArgs.append(startupURL)
        } else {
            browserArgs.append("--no-startup-window")
        }

        var env = environmentProvider()
        env["DYLD_FRAMEWORK_PATH"] = resolvedFrameworkPath
        env["DYLD_LIBRARY_PATH"] = env["DYLD_LIBRARY_PATH"] ?? resolvedFrameworkPath

        // Map the pipe fds to fd 3 and fd 4 for the child process using
        // posix_spawn file actions. Swift's `Process` doesn't natively
        // support arbitrary inherited file descriptors, so we go through
        // posix_spawn directly instead.
        //
        // From WebKit's perspective:
        //   fd 3 = read end of toWebKit pipe (WebKit reads commands)
        //   fd 4 = write end of fromWebKit pipe (WebKit writes responses)
        //
        // From parent's perspective:
        //   write end of toWebKit = send commands to WebKit
        //   read end of fromWebKit = receive responses from WebKit

        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)

        // Duplicate pipe read end to fd 3 (WebKit reads from here)
        posix_spawn_file_actions_adddup2(&fileActions, toWebKit[0], 3)
        // Duplicate pipe write end to fd 4 (WebKit writes here)
        posix_spawn_file_actions_adddup2(&fileActions, fromWebKit[1], 4)
        // Close the original pipe fds in the child
        posix_spawn_file_actions_addclose(&fileActions, toWebKit[0])
        posix_spawn_file_actions_addclose(&fileActions, toWebKit[1])
        posix_spawn_file_actions_addclose(&fileActions, fromWebKit[0])
        posix_spawn_file_actions_addclose(&fileActions, fromWebKit[1])

        // Build argv for posix_spawn (binary + same browser args computed above).
        let args = [binaryPath] + browserArgs
        let cArgs = args.map { strdup($0) } + [nil]
        defer { cArgs.forEach { free($0) } }

        // Build envp for posix_spawn
        let envStrings = env.map { "\($0.key)=\($0.value)" }
        let cEnv = envStrings.map { strdup($0) } + [nil]
        defer { cEnv.forEach { free($0) } }

        var pid: pid_t = 0
        let spawnResult = posix_spawn(&pid, binaryPath, &fileActions, nil, cArgs, cEnv)
        posix_spawn_file_actions_destroy(&fileActions)

        // Close the child-side ends of the pipes in the parent
        close(toWebKit[0])
        close(fromWebKit[1])

        guard spawnResult == 0 else {
            close(toWebKit[1])
            close(fromWebKit[0])
            throw WebKitLauncherError.pipeCreationFailed
        }

        let parentWriteHandle = FileHandle(fileDescriptor: toWebKit[1], closeOnDealloc: true)
        let parentReadHandle = FileHandle(fileDescriptor: fromWebKit[0], closeOnDealloc: true)

        logger.info("Launched WebKit at \(binaryPath) (pid: \(pid))")

        return WebKitProcess(
            pid: pid,
            pipeWrite: parentWriteHandle,
            pipeRead: parentReadHandle
        )
    }
}

