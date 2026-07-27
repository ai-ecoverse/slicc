import Foundation

enum SliccCliArchitecture: String, CaseIterable {
    case arm64
    case amd64

    static var current: SliccCliArchitecture {
        #if arch(arm64)
        return .arm64
        #elseif arch(x86_64)
        return .amd64
        #else
        return from(machine: ProcessInfo.processInfo.machineHardwareName) ?? .amd64
        #endif
    }

    static func from(machine: String) -> SliccCliArchitecture? {
        switch machine.lowercased() {
        case "arm64", "aarch64": .arm64
        case "x86_64", "amd64": .amd64
        default: nil
        }
    }
}

struct SliccCliLocator {
    private let fileManager: FileManager
    private let homeDirectory: URL
    private let repositoryRoots: [URL]
    private let pathDirectories: [URL]

    init(
        fileManager: FileManager = .default,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        repositoryRoots: [URL]? = nil,
        pathDirectories: [URL]? = nil
    ) {
        self.fileManager = fileManager
        self.homeDirectory = homeDirectory
        self.repositoryRoots = repositoryRoots ?? Self.defaultRepositoryRoots(fileManager: fileManager)
        self.pathDirectories = pathDirectories ?? [
            URL(fileURLWithPath: "/usr/local/bin"),
            homeDirectory.appendingPathComponent(".local/bin"),
            URL(fileURLWithPath: "/opt/homebrew/bin"),
        ]
    }

    func findCliBinary(architecture: SliccCliArchitecture = .current) -> String? {
        let managed = Self.managedBinDirectory(homeDirectory: homeDirectory)
            .appendingPathComponent("slicc")
        let developmentBins = repositoryRoots.map {
            $0.appendingPathComponent("packages/slicc-cli/bin/slicc")
        }
        let developmentDistributions = repositoryRoots.map {
            $0.appendingPathComponent("packages/slicc-cli/dist/slicc-darwin-\(architecture.rawValue)")
        }
        let pathCandidates = pathDirectories.map { $0.appendingPathComponent("slicc") }

        return ([managed] + developmentBins + developmentDistributions + pathCandidates)
            .first(where: isExecutableFile)?
            .path
    }

    static func managedBinDirectory(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        homeDirectory
            .appendingPathComponent("Library/Application Support/Sliccstart", isDirectory: true)
            .appendingPathComponent("bin", isDirectory: true)
    }

    private func isExecutableFile(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory)
            && !isDirectory.boolValue
            && fileManager.isExecutableFile(atPath: url.path)
    }

    private static func defaultRepositoryRoots(fileManager: FileManager) -> [URL] {
        var roots: [URL] = []
        var cursor = URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
        while cursor.path != "/" {
            roots.append(cursor)
            cursor.deleteLastPathComponent()
        }
        let checkout = URL(fileURLWithPath: SliccBootstrapper.defaultSliccDir, isDirectory: true)
        if !roots.contains(checkout) { roots.append(checkout) }
        return roots
    }
}

private extension ProcessInfo {
    var machineHardwareName: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        return withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
    }
}
