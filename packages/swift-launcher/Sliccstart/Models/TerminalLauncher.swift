import Darwin
import Foundation

struct TerminalLaunchCommand: Equatable {
    let executable: String
    let arguments: [String]
}

struct TerminalCommandResult: Equatable {
    let status: Int32
    let standardError: String
}

enum LoginShellResolver {
    static let fallbackShell = "/bin/zsh"

    static func resolve(
        shellFromPasswordDatabase: () -> String? = passwordDatabaseShell,
        isExecutableFile: (String) -> Bool = FileManager.default.isExecutableFile(atPath:)
    ) -> String {
        guard let shell = shellFromPasswordDatabase(),
            !shell.isEmpty,
            isExecutableFile(shell)
        else {
            return fallbackShell
        }
        return shell
    }

    static func passwordDatabaseShell() -> String? {
        guard let passwordRecord = getpwuid(getuid()),
            let shellPointer = passwordRecord.pointee.pw_shell
        else {
            return nil
        }
        return String(cString: shellPointer)
    }
}

struct TerminalLauncher {
    enum LaunchError: LocalizedError, Equatable {
        case couldNotCreateTemporaryScript
        case couldNotStart(String)
        case automationPermissionDenied(String)
        case processExited(String, Int32)

        var errorDescription: String? {
            switch self {
            case .couldNotCreateTemporaryScript:
                return "Could not prepare a temporary terminal launch script."
            case .couldNotStart(let terminalName):
                return "Could not start \(terminalName)."
            case .automationPermissionDenied(let terminalName):
                return "Sliccstart does not have permission to control \(terminalName). " + "Open System Settings > Privacy & Security > Automation, "
                    + "enable \(terminalName) for Sliccstart, then try again."
            case .processExited(let terminalName, let status):
                return "\(terminalName) launch failed with exit code \(status)."
            }
        }
    }

    typealias CommandRunner = (TerminalLaunchCommand) throws -> TerminalCommandResult

    private let commandRunner: CommandRunner

    init(commandRunner: @escaping CommandRunner = TerminalLauncher.run) {
        self.commandRunner = commandRunner
    }

    func launch(_ terminal: AppTarget, command: String) throws {
        let launchCommand = try Self.launchCommand(for: terminal, command: command)
        let result: TerminalCommandResult
        do {
            result = try commandRunner(launchCommand)
        } catch {
            throw LaunchError.couldNotStart(terminal.name)
        }
        guard result.status == 0 else {
            if launchCommand.executable == "/usr/bin/osascript",
                Self.isAutomationPermissionDenial(result.standardError)
            {
                throw LaunchError.automationPermissionDenied(terminal.name)
            }
            throw LaunchError.processExited(terminal.name, result.status)
        }
    }

    static func launchCommand(
        for terminal: AppTarget,
        command: String,
        loginShell: String = LoginShellResolver.resolve(),
        temporaryDirectory: URL = FileManager.default.temporaryDirectory,
        scriptName: String = "slicc-terminal-\(UUID().uuidString).command"
    ) throws -> TerminalLaunchCommand {
        if let directCommand = directLaunchCommand(
            for: terminal,
            command: command,
            loginShell: loginShell
        ) {
            return directCommand
        }
        return try temporaryScriptLaunchCommand(
            appName: terminal.name,
            command: command,
            loginShell: loginShell,
            scriptURL: temporaryDirectory.appendingPathComponent(scriptName)
        )
    }

    static func directLaunchCommand(
        for terminal: AppTarget,
        command: String,
        loginShell: String
    ) -> TerminalLaunchCommand? {
        guard
            let bundleIdentifier = AppTarget.knownTerminals.first(where: {
                $0.name == terminal.name
            })?.bundleId
        else {
            return nil
        }
        return directLaunchCommand(
            bundleIdentifier: bundleIdentifier,
            command: command,
            loginShell: loginShell
        )
    }

    static func directLaunchCommand(
        bundleIdentifier: String,
        command: String,
        loginShell: String
    ) -> TerminalLaunchCommand? {
        switch bundleIdentifier {
        case "com.apple.Terminal":
            return appleScriptCommand(script: terminalAppleScript, command: command)
        case "com.googlecode.iterm2":
            return appleScriptCommand(script: itermAppleScript, command: command)
        case "com.mitchellh.ghostty":
            return openCommand(appName: "Ghostty", arguments: ["-e", loginShell, "-lc", command])
        case "net.kovidgoyal.kitty":
            return openCommand(appName: "kitty", arguments: [loginShell, "-lc", command])
        case "org.alacritty":
            return openCommand(appName: "Alacritty", arguments: ["-e", loginShell, "-lc", command])
        case "com.github.wez.wezterm":
            return openCommand(appName: "WezTerm", arguments: ["start", "--", loginShell, "-lc", command])
        default:
            return nil
        }
    }

    static func temporaryScriptLaunchCommand(
        appName: String,
        command: String,
        loginShell: String,
        scriptURL: URL,
        fileManager: FileManager = .default
    ) throws -> TerminalLaunchCommand {
        let script = "#!/bin/sh\nexec \(shellQuote(loginShell)) -lc \(shellQuote(command))\n"
        do {
            try script.write(to: scriptURL, atomically: true, encoding: .utf8)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)
        } catch {
            throw LaunchError.couldNotCreateTemporaryScript
        }
        return TerminalLaunchCommand(
            executable: "/usr/bin/open",
            arguments: ["-a", appName, scriptURL.path]
        )
    }

    private static func appleScriptCommand(script: String, command: String) -> TerminalLaunchCommand {
        TerminalLaunchCommand(executable: "/usr/bin/osascript", arguments: ["-e", script, command])
    }

    private static func openCommand(appName: String, arguments: [String]) -> TerminalLaunchCommand {
        TerminalLaunchCommand(
            executable: "/usr/bin/open",
            arguments: ["-na", appName, "--args"] + arguments
        )
    }

    private static func shellQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }

    static func isAutomationPermissionDenial(_ standardError: String) -> Bool {
        standardError.contains("-1743")
            || standardError.localizedCaseInsensitiveContains(
                "not authorized to send Apple events"
            )
    }

    private static func run(_ launchCommand: TerminalLaunchCommand) throws -> TerminalCommandResult {
        let process = Process()
        let errorPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: launchCommand.executable)
        process.arguments = launchCommand.arguments
        process.standardError = errorPipe
        try process.run()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return TerminalCommandResult(
            status: process.terminationStatus,
            standardError: String(bytes: errorData, encoding: .utf8) ?? ""
        )
    }

    private static let terminalAppleScript = """
        on run argv
            tell application "Terminal"
                do script (item 1 of argv)
                activate
            end tell
        end run
        """

    private static let itermAppleScript = """
        on run argv
            tell application "iTerm2"
                set newWindow to (create window with default profile)
                tell current session of newWindow to write text (item 1 of argv)
                activate
            end tell
        end run
        """
}
