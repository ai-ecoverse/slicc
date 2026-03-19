import Foundation
import AppKit

@Observable
final class SliccProcess {
    /// All running instances keyed by AppTarget.id
    private var processes: [String: Process] = [:]
    private(set) var runningTargets: Set<String> = []

    var resolvedSliccDir: String { sliccDir }
    private var sliccDir: String {
        if let env = ProcessInfo.processInfo.environment["SLICC_DIR"], !env.isEmpty {
            return env
        }
        let parentDir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        var dir = parentDir
        for _ in 0..<5 {
            if FileManager.default.fileExists(atPath: dir + "/package.json") &&
               FileManager.default.fileExists(atPath: dir + "/src/cli/index.ts") {
                return dir
            }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return SliccBootstrapper.defaultSliccDir
    }

    /// Port allocation: browser gets 5710, electron apps get 5711, 5712, ...
    /// CDP ports: browser gets 9222, electron apps get 9223, 9224, ...
    private static let browserPort: UInt16 = 5710
    private static let browserCdpPort: UInt16 = 9222
    private static let electronBasePort: UInt16 = 5711
    private static let electronBaseCdpPort: UInt16 = 9223

    func isRunning(_ target: AppTarget) -> Bool {
        runningTargets.contains(target.id)
    }

    // MARK: - Browser mode

    func launchStandalone(_ browser: AppTarget) throws {
        if isRunning(browser) {
            // Already running — no-op
            return
        }
        guard !Self.isPortInUse(Self.browserPort) else { throw LaunchError.portInUse(Self.browserPort) }
        try spawn(target: browser, extraArgs: ["--cdp-port=\(Self.browserCdpPort)"], env: [
            "CHROME_PATH": browser.executablePath,
            "PORT": "\(Self.browserPort)",
        ])
    }

    // MARK: - Electron mode (each app gets its own port)

    func launchWithElectronApp(_ app: AppTarget) throws {
        if isRunning(app) {
            // Already running
            return
        }
        let (port, cdpPort) = nextElectronPorts()
        guard !Self.isPortInUse(port) else { throw LaunchError.portInUse(port) }
        try spawn(target: app, extraArgs: [
            "--electron", app.path,
            "--kill",
            "--cdp-port=\(cdpPort)",
        ], env: ["PORT": "\(port)"])
    }

    /// Find the next available port pair for an Electron app.
    private func nextElectronPorts() -> (port: UInt16, cdpPort: UInt16) {
        let electronCount = UInt16(processes.count) // offset from base
        for i: UInt16 in 0...20 {
            let port = Self.electronBasePort + electronCount + i
            let cdpPort = Self.electronBaseCdpPort + electronCount + i
            if !Self.isPortInUse(port) && !Self.isPortInUse(cdpPort) {
                return (port, cdpPort)
            }
        }
        // Fallback — try anyway
        let port = Self.electronBasePort + electronCount
        return (port, Self.electronBaseCdpPort + electronCount)
    }

    // MARK: - Guided extension install

    func guidedInstallExtension(chromePath: String) throws {
        let stablePath = NSHomeDirectory() + "/.slicc/extension"
        let sourcePath = sliccDir + "/dist/extension"
        let fm = FileManager.default

        if fm.fileExists(atPath: stablePath) {
            try fm.removeItem(atPath: stablePath)
        }
        try fm.copyItem(atPath: sourcePath, toPath: stablePath)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: chromePath)
        proc.arguments = ["chrome://extensions"]
        try proc.run()

        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: stablePath)
    }

    // MARK: - Lifecycle

    func stop(_ target: AppTarget) {
        processes[target.id]?.terminate()
        processes.removeValue(forKey: target.id)
        runningTargets.remove(target.id)
    }

    func stopAll() {
        for (_, proc) in processes { proc.terminate() }
        processes.removeAll()
        runningTargets.removeAll()
    }

    // MARK: - Private

    private func spawn(target: AppTarget, extraArgs: [String], env: [String: String]) throws {
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [sliccDir + "/dist/cli/index.js"] + extraArgs
        proc.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.processes.removeValue(forKey: target.id)
                self?.runningTargets.remove(target.id)
            }
        }
        try proc.run()
        processes[target.id] = proc
        runningTargets.insert(target.id)
    }

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

    enum LaunchError: LocalizedError {
        case nodeNotFound
        case portInUse(UInt16)
        var errorDescription: String? {
            switch self {
            case .nodeNotFound: return "Node.js not found"
            case .portInUse(let port): return "Port \(port) is already in use."
            }
        }
    }
}
