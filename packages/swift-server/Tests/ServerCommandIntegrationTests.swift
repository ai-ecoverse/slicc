import Foundation
import XCTest

@testable import slicc_server

final class ServerCommandIntegrationTests: XCTestCase {
    func testServeOnlyExecutableStartsAnswersAndShutsDown() async throws {
        try await runServer(arguments: ["--serve-only", "--cdp-port", "1"])
    }

    func testThinElectronServeOnlyStartsInjectorAndShutsDown() async throws {
        try await runServer(
            arguments: [
                "--serve-only", "--electron", "--cdp-port", "1",
                "--join", "https://tray.example.test/join/demo",
            ],
            environment: [
                "SLICC_BRIDGE_TOKEN": "integration-bridge-token",
                "SLICC_HOSTED_LEADER_ORIGIN": "https://www.sliccy.ai",
            ]
        )
    }

    func testChromeLaunchStartsCDPServicesAndShutsBrowserDown() async throws {
        let temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("slicc-fake-chrome-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporaryDirectory) }

        let chromeURL = temporaryDirectory.appendingPathComponent("fake-chrome.py")
        try makeFakeBrowserExecutable(at: chromeURL)
        let cdpPort = try await findAvailablePort(startingFrom: 63_000)
        try await runServer(
            arguments: ["--cdp-port", String(cdpPort), "--log-level", "debug"],
            environment: ["CHROME_PATH": chromeURL.path],
            startupDelayNanoseconds: 500_000_000
        )
    }

    func testElectronLaunchStartsThinOverlayAndShutsAppDown() async throws {
        let temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("slicc-fake-electron-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporaryDirectory) }

        let electronURL = temporaryDirectory.appendingPathComponent("fake-electron.py")
        try makeFakeBrowserExecutable(at: electronURL)
        let cdpPort = try await findAvailablePort(startingFrom: 63_000)
        try await runServer(
            arguments: [
                "--electron-app", electronURL.path,
                "--cdp-port", String(cdpPort),
                "--log-level", "debug",
            ],
            environment: [
                "SLICC_BRIDGE_TOKEN": "integration-electron-token",
                "SLICC_HOSTED_LEADER_ORIGIN": "https://www.sliccy.ai",
                "WORKER_BASE_URL": "https://tray.example.test",
            ],
            startupDelayNanoseconds: 500_000_000
        )
    }

    func testElectronServeOnlyWithoutTokenSkipsOverlay() async throws {
        try await runServer(
            arguments: [
                "--serve-only", "--electron", "--cdp-port", "1",
                "--env-file", "/dev/null/secrets.env",
            ]
        )
    }

    private func makeFakeBrowserExecutable(at url: URL) throws {
        let script = #"""
            #!/bin/sh
            port=""
            for argument in "$@"; do
                case "$argument" in
                    --remote-debugging-port=*) port=${argument#*=} ;;
                esac
            done
            [ -n "$port" ] || exit 64

            body='{"Browser":"Fake Chrome/1.0",'
            body="${body}\"webSocketDebuggerUrl\":\"ws://127.0.0.1:${port}/devtools/browser/test\"}"
            content_length=$(/usr/bin/printf '%s' "$body" | /usr/bin/wc -c | /usr/bin/tr -d ' ')
            /usr/bin/printf 'DevTools listening on ws://127.0.0.1:%s/devtools/browser/test\n' "$port" >&2

            while :; do
                /usr/bin/printf \
                    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
                    "$content_length" "$body" \
                    | /usr/bin/nc -l -w 1 127.0.0.1 "$port" >/dev/null
            done
            """#
        try Data(script.utf8).write(to: url)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: url.path
        )
    }

    private func runServer(
        arguments: [String],
        environment additions: [String: String] = [:],
        startupDelayNanoseconds: UInt64 = 100_000_000
    ) async throws {
        let port = try await findAvailablePort(
            startingFrom: 50_000 + Int.random(in: 0..<10_000)
        )
        let chromeProfileURL: URL?
        if additions["CHROME_PATH"] != nil {
            let profileURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
                .appendingPathComponent("Library/Application Support/Slicc/profiles", isDirectory: true)
                .appendingPathComponent("browser-coding-agent-chrome-\(port)", isDirectory: true)
            guard !FileManager.default.fileExists(atPath: profileURL.path) else {
                throw NSError(
                    domain: "ServerCommandIntegrationTests",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "refusing to overwrite existing profile at \(profileURL.path)"]
                )
            }
            chromeProfileURL = profileURL
        } else {
            chromeProfileURL = nil
        }
        defer {
            if let chromeProfileURL {
                try? FileManager.default.removeItem(at: chromeProfileURL)
            }
        }
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let binary = Bundle(for: Self.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("slicc-server")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: binary.path), binary.path)

        let temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("slicc-server-integration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporaryDirectory) }
        let outputURL = temporaryDirectory.appendingPathComponent("server-output.log")
        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        let outputHandle = try FileHandle(forWritingTo: outputURL)
        defer { try? outputHandle.close() }

        let process = Process()
        process.executableURL = binary
        process.currentDirectoryURL = packageRoot
        process.arguments = arguments + ["--log-dir", temporaryDirectory.path]
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["SLICC_KEYCHAIN_NONINTERACTIVE"] = "1"
        if let profilePath = environment["LLVM_PROFILE_FILE"] {
            let profileDirectory = URL(fileURLWithPath: profilePath).deletingLastPathComponent()
            environment["LLVM_PROFILE_FILE"] =
                profileDirectory
                .appendingPathComponent("slicc-server-\(UUID().uuidString)-%c.%p.profraw")
                .path
        }
        for (name, value) in additions { environment[name] = value }
        process.environment = environment
        process.standardOutput = outputHandle
        process.standardError = outputHandle

        try process.run()
        defer {
            if process.isRunning { process.terminate() }
        }

        try await waitForStatus(port: port, process: process)
        try await waitForStartupOutput(outputURL: outputURL, process: process)
        let terminated = expectation(description: "slicc-server exits after SIGTERM")
        process.terminationHandler = { _ in terminated.fulfill() }
        // The pre-warm failure is logged immediately before shutdown handling
        // is installed. Give the actor hop a moment to finish before SIGTERM.
        try await Task.sleep(nanoseconds: startupDelayNanoseconds)
        process.terminate()
        await fulfillment(of: [terminated], timeout: 10)
        XCTAssertEqual(process.terminationStatus, 0)
    }

    private func waitForStatus(port: Int, process: Process) async throws {
        let deadline = Date().addingTimeInterval(30)
        let url = URL(string: "http:
        while Date() < deadline {
            if !process.isRunning {
                throw NSError(
                    domain: "ServerCommandIntegrationTests",
                    code: Int(process.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: "slicc-server exited before becoming ready"]
                )
            }
            var request = URLRequest(url: url)
            request.timeoutInterval = 1
            if let (data, response) = try? await URLSession.shared.data(for: request),
                (response as? HTTPURLResponse)?.statusCode == 200,
                String(data: data, encoding: .utf8)?.contains("slicc-server") == true
            {
                return
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw NSError(
            domain: "ServerCommandIntegrationTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "timed out waiting for /api/status on port \(port)"]
        )
    }

    private func waitForStartupOutput(
        outputURL: URL,
        process: Process
    ) async throws {
        
        
        
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            let output = (try? String(contentsOf: outputURL, encoding: .utf8)) ?? ""
            if output.contains("CDP proxy at ws://localhost:")
                || output.contains("CDP proxy pre-warm failed")
            {
                return
            }
            if !process.isRunning {
                throw NSError(
                    domain: "ServerCommandIntegrationTests",
                    code: Int(process.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: output]
                )
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let output = (try? String(contentsOf: outputURL, encoding: .utf8)) ?? ""
        throw NSError(
            domain: "ServerCommandIntegrationTests",
            code: 2,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "timed out waiting for server startup output; captured: \(output)"
            ]
        )
    }
}
