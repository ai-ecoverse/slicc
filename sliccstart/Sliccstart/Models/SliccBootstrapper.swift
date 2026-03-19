import Foundation

enum InstallationStatus: Equatable {
    case notInstalled
    case needsBuild
    case installed
}

@Observable
final class SliccBootstrapper {
    static let repoURL = "https://github.com/ai-ecoverse/slicc.git"

    static var defaultSliccDir: String {
        NSHomeDirectory() + "/.slicc/slicc"
    }

    var progressMessage = ""
    var isWorking = false
    var lastError: String?

    static func findNode() -> String? {
        for candidate in [
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            NSHomeDirectory() + "/.nvm/current/bin/node",
        ] {
            if FileManager.default.fileExists(atPath: candidate) { return candidate }
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        task.arguments = ["node"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return output.isEmpty ? nil : output
    }

    static func checkInstallation(sliccDir: String = defaultSliccDir) -> InstallationStatus {
        let fm = FileManager.default
        guard fm.fileExists(atPath: sliccDir + "/package.json") else { return .notInstalled }
        guard fm.fileExists(atPath: sliccDir + "/dist/cli/index.js") else { return .needsBuild }
        return .installed
    }

    func bootstrap(sliccDir: String = SliccBootstrapper.defaultSliccDir) async throws {
        isWorking = true
        lastError = nil
        defer { isWorking = false }

        guard let nodePath = Self.findNode() else {
            throw BootstrapError.nodeNotFound
        }
        let npmPath = (nodePath as NSString).deletingLastPathComponent + "/npm"
        let fm = FileManager.default

        if !fm.fileExists(atPath: sliccDir + "/package.json") {
            progressMessage = "Cloning SLICC repository..."
            try fm.createDirectory(
                atPath: (sliccDir as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true
            )
            try runSync("/usr/bin/git", ["clone", "--depth", "1", Self.repoURL, sliccDir])
        }

        progressMessage = "Installing dependencies..."
        try runSync(npmPath, ["install"], cwd: sliccDir)

        progressMessage = "Building SLICC..."
        try runSync(npmPath, ["run", "build"], cwd: sliccDir)

        progressMessage = "Building extension..."
        try runSync(npmPath, ["run", "build:extension"], cwd: sliccDir)

        progressMessage = "Ready!"
    }

    func update(sliccDir: String = SliccBootstrapper.defaultSliccDir) async throws {
        isWorking = true
        lastError = nil
        defer { isWorking = false }

        guard let nodePath = Self.findNode() else { throw BootstrapError.nodeNotFound }
        let npmPath = (nodePath as NSString).deletingLastPathComponent + "/npm"

        progressMessage = "Pulling latest..."
        try runSync("/usr/bin/git", ["pull"], cwd: sliccDir)

        progressMessage = "Installing dependencies..."
        try runSync(npmPath, ["install"], cwd: sliccDir)

        progressMessage = "Building..."
        try runSync(npmPath, ["run", "build"], cwd: sliccDir)

        progressMessage = "Building extension..."
        try runSync(npmPath, ["run", "build:extension"], cwd: sliccDir)

        progressMessage = "Updated!"
    }

    /// Ensure PATH includes common tool locations (Homebrew, nvm, etc.)
    /// Finder-launched apps get a minimal PATH that may miss these.
    private static var enrichedEnvironment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extraPaths = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            NSHomeDirectory() + "/.nvm/current/bin",
        ]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        let allPaths = (extraPaths + currentPath.split(separator: ":").map(String.init))
        env["PATH"] = Array(Set(allPaths)).joined(separator: ":")
        return env
    }

    private func runSync(_ command: String, _ args: [String], cwd: String? = nil) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: command)
        task.arguments = args
        task.environment = Self.enrichedEnvironment
        if let cwd { task.currentDirectoryURL = URL(fileURLWithPath: cwd) }

        let stderrPipe = Pipe()
        task.standardOutput = FileHandle.nullDevice
        task.standardError = stderrPipe
        try task.run()
        task.waitUntilExit()

        guard task.terminationStatus == 0 else {
            let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let detail = stderr.isEmpty ? "" : "\n\(stderr.suffix(300))"
            throw BootstrapError.commandFailed("\(command) \(args.joined(separator: " "))\(detail)")
        }
    }

    enum BootstrapError: LocalizedError {
        case nodeNotFound
        case commandFailed(String)
        var errorDescription: String? {
            switch self {
            case .nodeNotFound: return "Node.js not found. Install from https://nodejs.org"
            case .commandFailed(let cmd): return "Command failed: \(cmd)"
            }
        }
    }
}
