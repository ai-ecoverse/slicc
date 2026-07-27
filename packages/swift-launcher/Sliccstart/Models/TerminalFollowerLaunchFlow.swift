import Foundation

enum AppListSection: CaseIterable {
    case browsers
    case desktopApps
    case terminals
    case browserExtension

    static func visibleSections(for targets: [AppTarget]) -> [AppListSection] {
        allCases.filter { section in
            switch section {
            case .browsers:
                targets.contains { $0.type == .chromiumBrowser }
            case .desktopApps:
                targets.contains { $0.type == .electronApp }
            case .terminals:
                targets.contains { $0.type == .terminal }
            case .browserExtension:
                true
            }
        }
    }
}

enum TerminalLaunchNextStep: Equatable {
    case blockedByMissingLeader
    case showWarning
    case confirmDownload
    case launch
}

enum TerminalLaunchDecision {
    static func nextStep(
        leaderReady: Bool,
        warningSuppressed: Bool,
        warningAcknowledged: Bool,
        cliAvailable: Bool
    ) -> TerminalLaunchNextStep {
        guard leaderReady else { return .blockedByMissingLeader }
        if !warningSuppressed && !warningAcknowledged { return .showWarning }
        return cliAvailable ? .launch : .confirmDownload
    }
}

struct TerminalFollowerLaunchService {
    typealias DownloadCLI = (@escaping SliccCliDownloader.ProgressHandler) async throws -> URL
    typealias ExposeCLI = (URL) -> Void
    typealias LaunchTerminal = (AppTarget, String) throws -> Void

    private let findCliBinary: () -> String?
    private let downloadCli: DownloadCLI
    private let exposeCli: ExposeCLI
    private let resolveLoginShell: () -> String
    private let loadTemplate: () -> String
    private let launchTerminal: LaunchTerminal

    init(
        findCliBinary: @escaping () -> String?,
        downloadCli: @escaping DownloadCLI,
        exposeCli: @escaping ExposeCLI = { _ in },
        resolveLoginShell: @escaping () -> String,
        loadTemplate: @escaping () -> String,
        launchTerminal: @escaping LaunchTerminal
    ) {
        self.findCliBinary = findCliBinary
        self.downloadCli = downloadCli
        self.exposeCli = exposeCli
        self.resolveLoginShell = resolveLoginShell
        self.loadTemplate = loadTemplate
        self.launchTerminal = launchTerminal
    }

    func isCliAvailable() -> Bool {
        findCliBinary() != nil
    }

    func launch(
        target: AppTarget,
        joinURL: String,
        progressHandler: @escaping SliccCliDownloader.ProgressHandler
    ) async throws {
        let sliccURL: URL
        if let existing = findCliBinary() {
            sliccURL = URL(fileURLWithPath: existing)
        } else {
            sliccURL = try await downloadCli(progressHandler)
        }
        exposeCli(sliccURL)

        let command = FollowCommandTemplate.expand(
            template: loadTemplate(),
            sliccPath: sliccURL.path,
            joinURL: joinURL,
            shellPath: resolveLoginShell()
        )
        try launchTerminal(target, command)
    }

    static let live = TerminalFollowerLaunchService(
        findCliBinary: { SliccCliLocator().findCliBinary() },
        downloadCli: { progressHandler in
            try await SliccCliDownloader(progressHandler: progressHandler).download()
        },
        exposeCli: { _ = SliccCliPathExposure().expose($0) },
        resolveLoginShell: { LoginShellResolver.resolve() },
        loadTemplate: {
            UserDefaults.standard.string(forKey: terminalFollowCommandKey)
                ?? FollowCommandTemplate.defaultTemplate
        },
        launchTerminal: { target, command in
            try TerminalLauncher().launch(target, command: command)
        }
    )
}

extension SliccCliDownloadProgress {
    var statusText: String {
        switch self {
        case .preparing:
            "Preparing slicc CLI download…"
        case .downloading(let attempt, let totalAttempts):
            "Downloading slicc CLI (attempt \(attempt) of \(totalAttempts))…"
        case .validating:
            "Validating slicc CLI…"
        case .installing:
            "Installing slicc CLI…"
        case .finished:
            "Opening terminal…"
        }
    }
}
