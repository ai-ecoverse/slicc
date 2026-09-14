import AppKit
import XCTest

@testable import Sliccstart

final class TerminalLauncherTests: XCTestCase {
    func testTerminalAndITermUseCommandAsSeparateAppleScriptArgument() throws {
        let command = #"printf "it's $HOME" && echo \"done\""#

        for (name, application) in [("Terminal", "Terminal"), ("iTerm2", "iTerm2")] {
            let launch = try TerminalLauncher.launchCommand(
                for: target(name: name),
                command: command,
                loginShell: "/bin/zsh"
            )

            XCTAssertEqual(launch.executable, "/usr/bin/osascript")
            XCTAssertEqual(launch.arguments.last, command)
            XCTAssertFalse(launch.arguments[1].contains(command))
            XCTAssertTrue(launch.arguments[1].contains("application \"\(application)\""))
        }
    }

    func testCommandLineTerminalArguments() throws {
        let command = #"echo "hello world" '$HOME'"#
        let expected: [(String, [String])] = [
            ("Ghostty", ["-na", "Ghostty", "--args", "-e", "/bin/fish", "-lc", command]),
            ("kitty", ["-na", "kitty", "--args", "/bin/fish", "-lc", command]),
            ("Alacritty", ["-na", "Alacritty", "--args", "-e", "/bin/fish", "-lc", command]),
            ("WezTerm", ["-na", "WezTerm", "--args", "start", "--", "/bin/fish", "-lc", command]),
        ]

        for (name, arguments) in expected {
            let launch = try TerminalLauncher.launchCommand(
                for: target(name: name),
                command: command,
                loginShell: "/bin/fish"
            )
            XCTAssertEqual(launch, TerminalLaunchCommand(executable: "/usr/bin/open", arguments: arguments))
        }
    }

    func testStrategiesAreKeyedByBundleIdentifier() {
        XCTAssertNotNil(
            TerminalLauncher.directLaunchCommand(
                bundleIdentifier: "com.mitchellh.ghostty",
                command: "true",
                loginShell: "/bin/zsh"
            ))
        XCTAssertNil(
            TerminalLauncher.directLaunchCommand(
                bundleIdentifier: "com.example.unsupported",
                command: "true",
                loginShell: "/bin/zsh"
            ))
    }

    func testLoginShellResolverAcceptsExecutablePasswordDatabaseShell() {
        let shell = LoginShellResolver.resolve(
            shellFromPasswordDatabase: { "/opt/homebrew/bin/fish" },
            isExecutableFile: { $0 == "/opt/homebrew/bin/fish" }
        )

        XCTAssertEqual(shell, "/opt/homebrew/bin/fish")
    }

    func testLoginShellResolverFallsBackForMissingOrNonExecutableShell() {
        XCTAssertEqual(
            LoginShellResolver.resolve(
                shellFromPasswordDatabase: { nil },
                isExecutableFile: { _ in true }
            ),
            "/bin/zsh"
        )
        XCTAssertEqual(
            LoginShellResolver.resolve(
                shellFromPasswordDatabase: { "/bin/not-executable" },
                isExecutableFile: { _ in false }
            ),
            "/bin/zsh"
        )
    }

    func testTemporaryScriptFallbackIsExecutableAndShellQuoted() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let scriptURL = directory.appendingPathComponent("follow.command")
        let command = #"printf '%s' "$HOME""#

        let launch = try TerminalLauncher.temporaryScriptLaunchCommand(
            appName: "Fallback Terminal",
            command: command,
            loginShell: "/bin/zsh",
            scriptURL: scriptURL
        )

        XCTAssertEqual(launch.executable, "/usr/bin/open")
        XCTAssertEqual(launch.arguments, ["-a", "Fallback Terminal", scriptURL.path])
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: scriptURL.path))
        XCTAssertEqual(
            try String(contentsOf: scriptURL, encoding: .utf8),
            "#!/bin/sh\nexec '/bin/zsh' -lc 'printf '\"'\"'%s'\"'\"' \"$HOME\"'\n"
        )
    }

    func testLaunchSurfacesTypedRunnerFailures() {
        let startFailure = TerminalLauncher(commandRunner: { _ in throw CocoaError(.fileNoSuchFile) })
        XCTAssertThrowsError(try startFailure.launch(target(name: "Terminal"), command: "true")) { error in
            XCTAssertEqual(error as? TerminalLauncher.LaunchError, .couldNotStart("Terminal"))
        }

        let exitFailure = TerminalLauncher(commandRunner: { _ in
            TerminalCommandResult(status: 9, standardError: "launch failed")
        })
        XCTAssertThrowsError(try exitFailure.launch(target(name: "Terminal"), command: "true")) { error in
            XCTAssertEqual(error as? TerminalLauncher.LaunchError, .processExited("Terminal", 9))
        }
    }

    func testLaunchSurfacesActionableAutomationPermissionDenial() {
        let launcher = TerminalLauncher(commandRunner: { _ in
            TerminalCommandResult(
                status: 1,
                standardError: "execution error: Not authorized to send Apple events to Terminal. (-1743)"
            )
        })

        XCTAssertThrowsError(try launcher.launch(target(name: "Terminal"), command: "true")) { error in
            let expected = TerminalLauncher.LaunchError.automationPermissionDenied("Terminal")
            XCTAssertEqual(error as? TerminalLauncher.LaunchError, expected)
            XCTAssertTrue(error.localizedDescription.contains("System Settings > Privacy & Security > Automation"))
        }
    }

    func testNonAppleScriptFailureIsNotMisclassifiedAsAutomationDenial() {
        let launcher = TerminalLauncher(commandRunner: { _ in
            TerminalCommandResult(status: 1, standardError: "Not authorized to send Apple events (-1743)")
        })

        XCTAssertThrowsError(try launcher.launch(target(name: "Ghostty"), command: "true")) { error in
            XCTAssertEqual(error as? TerminalLauncher.LaunchError, .processExited("Ghostty", 1))
        }
    }

    func testAutomationPermissionDenialDetectionAcceptsCodeAndMessage() {
        XCTAssertTrue(TerminalLauncher.isAutomationPermissionDenial("execution error (-1743)"))
        XCTAssertTrue(TerminalLauncher.isAutomationPermissionDenial("NOT AUTHORIZED TO SEND APPLE EVENTS"))
        XCTAssertFalse(TerminalLauncher.isAutomationPermissionDenial("syntax error (-2741)"))
    }

    private func target(name: String) -> AppTarget {
        AppTarget(
            id: "/Applications/\(name).app",
            name: name,
            path: "/Applications/\(name).app",
            executablePath: "/Applications/\(name).app/Contents/MacOS/\(name)",
            type: .terminal,
            icon: NSImage(),
            debugSupport: .unknown,
            isDebugBuild: false,
            originalAppPath: nil
        )
    }
}
