import AppKit
import Foundation

final class DebugBuildCreator {
    enum DebugBuildError: LocalizedError {
        case notElectronApp
        case copyFailed(String)
        case fusePatchFailed(String)
        case asarExtractionFailed(String)
        case jsPatcFailed(String)
        case asarRepackFailed(String)
        case signingFailed(String)

        var errorDescription: String? {
            switch self {
            case .notElectronApp:
                return "Not an Electron app"
            case .copyFailed(let msg):
                return "Failed to copy app: \(msg)"
            case .fusePatchFailed(let msg):
                return "Failed to patch fuses: \(msg)"
            case .asarExtractionFailed(let msg):
                return "Failed to extract app.asar: \(msg)"
            case .jsPatcFailed(let msg):
                return "Failed to patch JavaScript: \(msg)"
            case .asarRepackFailed(let msg):
                return "Failed to repack app.asar: \(msg)"
            case .signingFailed(let msg):
                return "Failed to sign app: \(msg)"
            }
        }
    }

    static var userApplicationsDir: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Applications"
    }

    static func createDebugBuild(from appPath: String, progressHandler: ((String) -> Void)? = nil) async throws -> String {
        let fm = FileManager.default
        let appName = AppScanner.appName(fromPath: appPath)
        let debugAppPath = "\(userApplicationsDir)/\(appName) Debug.app"

        if !fm.fileExists(atPath: userApplicationsDir) {
            try fm.createDirectory(atPath: userApplicationsDir, withIntermediateDirectories: true)
        }

        if fm.fileExists(atPath: debugAppPath) {
            try fm.removeItem(atPath: debugAppPath)
        }

        progressHandler?("Copying app...")
        do {
            try fm.copyItem(atPath: appPath, toPath: debugAppPath)
        } catch {
            throw DebugBuildError.copyFailed(error.localizedDescription)
        }

        progressHandler?("Patching Electron fuses...")
        try await patchFuses(appPath: debugAppPath)

        progressHandler?("Patching JavaScript...")
        try await patchAsar(appPath: debugAppPath)

        progressHandler?("Signing app...")
        try await signApp(appPath: debugAppPath)

        progressHandler?("Removing quarantine...")
        try await removeQuarantine(appPath: debugAppPath)

        progressHandler?("Done!")
        return debugAppPath
    }

    static func resolveModuleBin(_ packageName: String, binName: String? = nil) -> (String, [String]) {
        let bin = binName ?? String(packageName.split(separator: "/").last ?? Substring(packageName))

        if let nodePath = SliccBootstrapper.bundledNodePath,
            let sliccDir = SliccBootstrapper.bundledSliccDir
        {

            let binPath = sliccDir + "/node_modules/.bin/" + bin
            if FileManager.default.fileExists(atPath: binPath) {
                return (nodePath, [binPath])
            }
        }

        return ("/usr/bin/env", ["npx", packageName])
    }

    private static func patchFuses(appPath: String) async throws {
        let (executable, argsPrefix) = resolveModuleBin("@electron/fuses", binName: "electron-fuses")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments =
            argsPrefix + [
                "write",
                "--app", appPath,
                "EnableNodeCliInspectArguments=on",
                "EnableEmbeddedAsarIntegrityValidation=off",
                "OnlyLoadAppFromAsar=off",
            ]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        try process.run()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            throw DebugBuildError.fusePatchFailed(output)
        }
    }

    static func patchAsar(appPath: String) async throws {
        let fm = FileManager.default
        let asarPath = "\(appPath)/Contents/Resources/app.asar"
        let tempDir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path

        guard fm.fileExists(atPath: asarPath) else {

            return
        }

        try fm.createDirectory(atPath: tempDir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: tempDir) }

        let extractedPath = "\(tempDir)/extracted"

        let (asarExe, asarPrefix) = resolveModuleBin("@electron/asar", binName: "asar")
        let extractProcess = Process()
        extractProcess.executableURL = URL(fileURLWithPath: asarExe)
        extractProcess.arguments = asarPrefix + ["extract", asarPath, extractedPath]
        extractProcess.standardOutput = FileHandle.nullDevice
        extractProcess.standardError = FileHandle.nullDevice

        try extractProcess.run()
        extractProcess.waitUntilExit()

        if extractProcess.terminationStatus != 0 {
            throw DebugBuildError.asarExtractionFailed("asar extract failed")
        }

        try patchJavaScriptFiles(inDirectory: extractedPath)

        let packProcess = Process()
        packProcess.executableURL = URL(fileURLWithPath: asarExe)
        packProcess.arguments = asarPrefix + ["pack", extractedPath, asarPath]
        packProcess.standardOutput = FileHandle.nullDevice
        packProcess.standardError = FileHandle.nullDevice

        try packProcess.run()
        packProcess.waitUntilExit()

        if packProcess.terminationStatus != 0 {
            throw DebugBuildError.asarRepackFailed("asar pack failed")
        }
    }

    static func patchJavaScriptFiles(inDirectory dir: String) throws {
        let fm = FileManager.default

        let patterns = [

            ("Lx(process.argv)&&!HM()&&process.exit(1)", "true"),

            ("process.argv.some(function(e){return e.startsWith(\"--remote-debugging\")})", "false"),
            ("process.argv.some(e=>e.startsWith(\"--remote-debugging\"))", "false"),
            ("process.argv.some(e=>e.startsWith('--remote-debugging'))", "false"),
        ]

        let buildDir = "\(dir)/.vite/build"
        if fm.fileExists(atPath: buildDir) {
            try patchFilesInDirectory(buildDir, patterns: patterns)
        }

        try patchFilesInDirectory(dir, patterns: patterns, recursive: false)
    }

    static func patchFilesInDirectory(_ dir: String, patterns: [(String, String)], recursive: Bool = true) throws {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(atPath: dir) else { return }

        while let file = enumerator.nextObject() as? String {
            if !recursive && file.contains("/") { continue }
            guard file.hasSuffix(".js") else { continue }

            let filePath = "\(dir)/\(file)"
            guard var content = try? String(contentsOfFile: filePath, encoding: .utf8) else { continue }

            var modified = false
            for (pattern, replacement) in patterns {
                if content.contains(pattern) {
                    content = content.replacingOccurrences(of: pattern, with: replacement)
                    modified = true
                }
            }

            if modified {
                try content.write(toFile: filePath, atomically: true, encoding: .utf8)
            }
        }
    }

    static func signApp(appPath: String) async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = ["--force", "--deep", "--sign", "-", appPath]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        try process.run()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""

            if output.contains("error:") {
                throw DebugBuildError.signingFailed(output)
            }
        }
    }

    static func removeQuarantine(appPath: String) async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        process.arguments = ["-cr", appPath]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

    }

    static func debugBuildExists(for appPath: String) -> Bool {
        let appName = AppScanner.appName(fromPath: appPath)
        let debugAppPath = "\(userApplicationsDir)/\(appName) Debug.app"
        return FileManager.default.fileExists(atPath: debugAppPath)
    }

    static func debugBuildPath(for appPath: String) -> String {
        let appName = AppScanner.appName(fromPath: appPath)
        return "\(userApplicationsDir)/\(appName) Debug.app"
    }

    static func deleteDebugBuild(for appPath: String) throws {
        let debugPath = debugBuildPath(for: appPath)
        if FileManager.default.fileExists(atPath: debugPath) {
            try FileManager.default.removeItem(atPath: debugPath)
        }
    }
}
