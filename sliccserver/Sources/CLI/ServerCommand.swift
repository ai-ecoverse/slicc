import ArgumentParser
import Foundation

@main
@available(macOS 10.15, *)
struct ServerCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "slicc-server",
        abstract: "Run the native SLICC standalone server."
    )

    @Flag(name: .long, help: "Enable dev mode")
    var dev: Bool = false

    @Flag(name: .long, help: "Serve-only mode (reuse external CDP)")
    var serveOnly: Bool = false

    @Option(name: .long, help: "CDP port")
    var cdpPort: Int = ServerConfig.defaultCliCdpPort

    @Flag(name: .long, help: "Electron mode")
    var electron: Bool = false

    @Option(name: .long, help: "Electron app path")
    var electronApp: String?

    @Flag(name: .long, help: "Kill existing Electron app")
    var kill: Bool = false

    @Flag(name: .long, help: "Lead mode")
    var lead: Bool = false

    @Option(name: .long, help: "Lead worker base URL")
    var leadWorkerBaseUrl: String?

    @Option(name: .long, help: "Chrome profile name")
    var profile: String?

    @Flag(name: .long, help: "Join mode")
    var join: Bool = false

    @Option(name: .long, help: "Join URL")
    var joinUrl: String?

    @Option(name: .long, help: "Log level")
    var logLevel: String = "info"

    @Option(name: .long, help: "Log directory")
    var logDir: String?

    @Option(name: .long, help: "Auto-submit prompt")
    var prompt: String?
}

struct ServerConfig: Sendable, Equatable {
    static let defaultCliCdpPort = 9222
    static let defaultElectronAttachCdpPort = 9223
    static let validLogLevels: Set<String> = ["debug", "info", "warn", "error"]

    let dev: Bool
    let serveOnly: Bool
    let cdpPort: Int
    let explicitCdpPort: Bool
    let electron: Bool
    let electronApp: String?
    let electronAppURL: URL?
    let kill: Bool
    let lead: Bool
    let leadWorkerBaseUrl: String?
    let leadWorkerBaseURL: URL?
    let profile: String?
    let join: Bool
    let joinUrl: String?
    let joinURL: URL?
    let logLevel: String
    let logDir: String?
    let logDirectoryURL: URL?
    let prompt: String?

    static func resolve(from command: ServerCommand) -> ServerConfig {
        resolve(from: command, arguments: ProcessInfo.processInfo.arguments)
    }

    static func resolve(from command: ServerCommand, arguments: [String]) -> ServerConfig {
        let explicitCdpPort = arguments.dropFirst().contains {
            $0 == "--cdp-port" || $0.hasPrefix("--cdp-port=")
        }

        let normalizedElectronApp = normalizedText(command.electronApp)
        let normalizedLeadWorkerBaseUrl = normalizedText(command.leadWorkerBaseUrl)
        let normalizedProfile = normalizedText(command.profile)
        let normalizedJoinUrl = normalizedText(command.joinUrl)
        let normalizedLogDir = normalizedText(command.logDir)
        let normalizedPrompt = normalizedText(command.prompt)

        let positiveCdpPort = command.cdpPort > 0 ? command.cdpPort : defaultCliCdpPort
        let resolvedElectron = command.electron || normalizedElectronApp != nil
        let resolvedLead = command.lead || normalizedLeadWorkerBaseUrl != nil
        let resolvedJoin = command.join || normalizedJoinUrl != nil
        let resolvedCdpPort = resolvedElectron && !explicitCdpPort
            ? defaultElectronAttachCdpPort
            : positiveCdpPort

        return ServerConfig(
            dev: command.dev,
            serveOnly: command.serveOnly,
            cdpPort: resolvedCdpPort,
            explicitCdpPort: explicitCdpPort && command.cdpPort > 0,
            electron: resolvedElectron,
            electronApp: normalizedElectronApp,
            electronAppURL: resolvedFileURL(from: normalizedElectronApp),
            kill: command.kill,
            lead: resolvedLead,
            leadWorkerBaseUrl: normalizedLeadWorkerBaseUrl,
            leadWorkerBaseURL: resolvedURL(from: normalizedLeadWorkerBaseUrl),
            profile: normalizedProfile,
            join: resolvedJoin,
            joinUrl: normalizedJoinUrl,
            joinURL: resolvedURL(from: normalizedJoinUrl),
            logLevel: normalizedLogLevel(command.logLevel),
            logDir: normalizedLogDir,
            logDirectoryURL: resolvedFileURL(from: normalizedLogDir),
            prompt: normalizedPrompt
        )
    }

    private static func normalizedText(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func normalizedLogLevel(_ value: String) -> String {
        let normalizedValue = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return validLogLevels.contains(normalizedValue) ? normalizedValue : "info"
    }

    private static func resolvedURL(from value: String?) -> URL? {
        guard let value else {
            return nil
        }
        return URL(string: value)
    }

    private static func resolvedFileURL(from value: String?) -> URL? {
        guard let value else {
            return nil
        }

        let expandedPath = NSString(string: value).expandingTildeInPath
        return URL(fileURLWithPath: expandedPath).standardizedFileURL
    }
}