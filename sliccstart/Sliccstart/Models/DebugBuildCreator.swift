import Foundation
import AppKit

/// Creates debug builds of Electron apps by patching fuses and bypassing CDP auth checks
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

    /// Path to ~/Applications
    static var userApplicationsDir: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Applications"
    }

    /// Create a debug build of an Electron app
    /// - Parameter appPath: Path to the original app (e.g., /Applications/Claude.app)
    /// - Returns: Path to the created debug build
    static func createDebugBuild(from appPath: String, progressHandler: ((String) -> Void)? = nil) async throws -> String {
        let fm = FileManager.default
        let appName = AppScanner.appName(fromPath: appPath)
        let debugAppPath = "\(userApplicationsDir)/\(appName) Debug.app"

        // Ensure ~/Applications exists
        if !fm.fileExists(atPath: userApplicationsDir) {
            try fm.createDirectory(atPath: userApplicationsDir, withIntermediateDirectories: true)
        }

        // Remove existing debug build if present
        if fm.fileExists(atPath: debugAppPath) {
            try fm.removeItem(atPath: debugAppPath)
        }

        // Step 1: Copy app to ~/Applications
        progressHandler?("Copying app...")
        do {
            try fm.copyItem(atPath: appPath, toPath: debugAppPath)
        } catch {
            throw DebugBuildError.copyFailed(error.localizedDescription)
        }

        // Step 2: Flip Electron fuses using @electron/fuses
        progressHandler?("Patching Electron fuses...")
        try await patchFuses(appPath: debugAppPath)

        // Step 3: Extract, patch, and repack app.asar
        progressHandler?("Patching JavaScript...")
        try await patchAsar(appPath: debugAppPath)

        // Step 4: Ad-hoc sign the app
        progressHandler?("Signing app...")
        try await signApp(appPath: debugAppPath)

        // Step 5: Remove quarantine attributes
        progressHandler?("Removing quarantine...")
        try await removeQuarantine(appPath: debugAppPath)

        progressHandler?("Done!")
        return debugAppPath
    }

    /// Resolve a bundled node_modules binary script, falling back to npx for dev mode.
    /// Returns (executable, arguments-prefix). In bundled mode: (node, [script, ...]).
    /// In dev mode: (/usr/bin/env, [npx, package, ...]).
    private static func resolveModuleBin(_ packageName: String, binName: String? = nil) -> (String, [String]) {
        let bin = binName ?? String(packageName.split(separator: "/").last ?? Substring(packageName))

        // Bundled mode: use node + the script directly from node_modules/.bin/
        if let nodePath = SliccBootstrapper.bundledNodePath,
           let sliccDir = SliccBootstrapper.bundledSliccDir {
            // node_modules/.bin/<name> is a symlink to the actual script
            let binPath = sliccDir + "/node_modules/.bin/" + bin
            if FileManager.default.fileExists(atPath: binPath) {
                return (nodePath, [binPath])
            }
        }

        // Dev mode: use npx
        return ("/usr/bin/env", ["npx", packageName])
    }

    /// Patch Electron fuses to enable remote debugging
    private static func patchFuses(appPath: String) async throws {
        let (executable, argsPrefix) = resolveModuleBin("@electron/fuses", binName: "electron-fuses")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = argsPrefix + [
            "write",
            "--app", appPath,
            "EnableNodeCliInspectArguments=on",
            "EnableEmbeddedAsarIntegrityValidation=off",
            "OnlyLoadAppFromAsar=off"
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

    /// Patch the app.asar to bypass CDP auth checks
    private static func patchAsar(appPath: String) async throws {
        let fm = FileManager.default
        let asarPath = "\(appPath)/Contents/Resources/app.asar"
        let tempDir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).path

        guard fm.fileExists(atPath: asarPath) else {
            // No asar to patch, might be unpacked already
            return
        }

        // Create temp directory
        try fm.createDirectory(atPath: tempDir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: tempDir) }

        let extractedPath = "\(tempDir)/extracted"

        // Extract asar
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

        // Find and patch JavaScript files that check for remote-debugging-port
        try patchJavaScriptFiles(inDirectory: extractedPath)

        // Repack asar
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

    /// Find and patch JS files that block remote debugging
    private static func patchJavaScriptFiles(inDirectory dir: String) throws {
        let fm = FileManager.default

        // Common patterns that apps use to block remote debugging:
        // 1. Check for --remote-debugging-port in process.argv and exit
        // Pattern: Lx(process.argv)&&!HM()&&process.exit(1)  (Claude)
        // Pattern: process.argv.some(arg => arg.startsWith("--remote-debugging")) && process.exit(1)

        let patterns = [
            // Claude's pattern: Lx(process.argv)&&!HM()&&process.exit(1)
            // We replace the whole check with 'true' (no-op)
            ("Lx(process.argv)&&!HM()&&process.exit(1)", "true"),

            // Generic pattern: checking argv for remote-debugging and exiting
            ("process.argv.some(function(e){return e.startsWith(\"--remote-debugging\")})", "false"),
            ("process.argv.some(e=>e.startsWith(\"--remote-debugging\"))", "false"),
            ("process.argv.some(e=>e.startsWith('--remote-debugging'))", "false"),
        ]

        // Walk through .vite/build directory for bundled JS
        let buildDir = "\(dir)/.vite/build"
        if fm.fileExists(atPath: buildDir) {
            try patchFilesInDirectory(buildDir, patterns: patterns)
        }

        // Also check root for index.js etc
        try patchFilesInDirectory(dir, patterns: patterns, recursive: false)
    }

    private static func patchFilesInDirectory(_ dir: String, patterns: [(String, String)], recursive: Bool = true) throws {
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

    /// Ad-hoc sign the app
    private static func signApp(appPath: String) async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = ["--force", "--deep", "--sign", "-", appPath]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        try process.run()
        process.waitUntilExit()

        // codesign may return non-zero for warnings, check if app is usable
        if process.terminationStatus != 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            // Only throw if it's a real error, not just a warning
            if output.contains("error:") {
                throw DebugBuildError.signingFailed(output)
            }
        }
    }

    /// Remove quarantine extended attributes
    private static func removeQuarantine(appPath: String) async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        process.arguments = ["-cr", appPath]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()
        // Ignore errors - xattr may fail if no quarantine attribute exists
    }

    /// Check if a debug build exists for an app
    static func debugBuildExists(for appPath: String) -> Bool {
        let appName = AppScanner.appName(fromPath: appPath)
        let debugAppPath = "\(userApplicationsDir)/\(appName) Debug.app"
        return FileManager.default.fileExists(atPath: debugAppPath)
    }

    /// Get the debug build path for an app
    static func debugBuildPath(for appPath: String) -> String {
        let appName = AppScanner.appName(fromPath: appPath)
        return "\(userApplicationsDir)/\(appName) Debug.app"
    }

    /// Delete a debug build
    static func deleteDebugBuild(for appPath: String) throws {
        let debugPath = debugBuildPath(for: appPath)
        if FileManager.default.fileExists(atPath: debugPath) {
            try FileManager.default.removeItem(atPath: debugPath)
        }
    }
}
