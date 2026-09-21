import Foundation

/// Headless `Sliccstart --computer-follow <join-url> [--pair <id>]` and
/// `Sliccstart --computer-preflight [--json]` support (issue #3260).
///
/// `slicc <join-url> follow --computer` needs this Mac's screen, and the Go CLI
/// cannot take it: it builds `CGO_ENABLED=0`, so ScreenCaptureKit and CGEvent
/// are out of reach — and even a cgo build would be the wrong asker, because
/// macOS attributes a TCC grant to the *responsible* process, which for a bare
/// binary is the terminal that launched it. So the CLI shells out to this
/// signed bundle, exactly as it already does for `--list-sessions`, and the
/// Screen Recording / Accessibility prompts name SLICC.
///
/// "Headless" here means no menu-bar UI, no widget observer, no window — just
/// ``ComputerTrayFollower`` dialing one leader for as long as the CLI lives.
///
/// Everything in this type is pure so it is unit-tested without AppKit, TCC, or
/// a live leader; the untestable glue (NSApplication, the run loop, the real
/// permission probes) sits in ``ComputerFollowCLIRunner``.
enum ComputerFollowCLI {
    /// A parsed headless invocation. `parse` returns nil for a normal GUI
    /// launch so `main` falls through to the SwiftUI app.
    enum Request: Equatable {
        /// Dial `joinUrl` as a computer-only follower until terminated.
        case follow(joinUrl: String, pairId: String?)
        /// Raise both TCC prompts, report what is granted, exit.
        case preflight(json: Bool)
    }

    static let followFlag = "--computer-follow"
    static let pairFlag = "--pair"
    static let preflightFlag = "--computer-preflight"
    static let jsonFlag = "--json"

    /// First line `--computer-follow` prints on stdout: "I understand this
    /// flag". It is printed at once, before any network work.
    ///
    /// Load-bearing, not a log: an older Sliccstart ignores unknown arguments
    /// and boots its GUI, which never exits, so "did it print this?" is the
    /// only way the CLI can tell a launcher that understands the flag from one
    /// that silently did something else. It deliberately does NOT mean
    /// attached — that is ``attachedLine`` — so an unreachable leader is never
    /// misreported as an outdated launcher.
    ///
    /// All three lines are mirrored in
    /// `packages/slicc-cli/internal/computer/session_darwin.go`.
    static let readyLine = "SLICC_COMPUTER_FOLLOW_READY"

    /// Printed once, when the data channel is open and `hello` has gone out —
    /// the first moment the leader can actually reach this Mac's screen.
    /// `slicc follow --computer=require` waits for this line, not for
    /// ``readyLine``, before it treats the screen as present.
    static let attachedLine = "SLICC_COMPUTER_FOLLOW_ATTACHED"

    /// Prefix of the line printed right before exiting because attaching
    /// failed for good. The rest of the line is the reason, for the CLI to show.
    static let failedPrefix = "SLICC_COMPUTER_FOLLOW_FAILED"

    /// One line, whatever the reason contains: the CLI reads stdout line by
    /// line, and a multi-line error would split into a truncated reason plus
    /// stray log lines.
    static func failedLine(reason: String) -> String {
        let flattened = reason.split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        return flattened.isEmpty ? failedPrefix : "\(failedPrefix) \(flattened)"
    }

    /// Turns the follower's connect / give-up callbacks into what the headless
    /// process says and does. A value type so the one-shot rules are tested
    /// without a leader.
    struct AttachReporter: Equatable {
        enum Action: Equatable {
            case none
            case print(String)
            /// Print, then exit with this status.
            case printAndExit(String, Int32)
        }

        private(set) var attached = false

        /// Only the first open is news. A later reconnect after a leader drop
        /// is routine, and repeating the line would read to the CLI as noise.
        mutating func connected() -> Action {
            guard !attached else { return .none }
            attached = true
            return .print(ComputerFollowCLI.attachedLine)
        }

        /// Giving up always ends the process, before or after the first attach.
        /// Before it, the CLI is waiting and needs the reason. After it, the
        /// launcher is a dead peer nobody can reach, and lingering would only
        /// keep a process around that owns Screen Recording for no one.
        mutating func gaveUp(_ reason: String) -> Action {
            .printAndExit(ComputerFollowCLI.failedLine(reason: reason), 1)
        }
    }

    // MARK: - Parent liveness

    /// Whether the process that spawned this one is already gone.
    ///
    /// A launcher that outlives its CLI keeps a leader able to capture this
    /// screen after the user believes the session ended — the CLI's deferred
    /// SIGTERM never runs if it was SIGKILLed or crashed. macOS reparents an
    /// orphan to launchd (pid 1), so a parent pid of 1 (or an impossible 0)
    /// means the owner already died, possibly before a watch could be armed.
    static func parentIsGone(parentPid: Int32) -> Bool { parentPid <= 1 }

    enum ParseError: Error, Equatable {
        case missingJoinUrl
        case invalidJoinUrl(String)
        case missingPairId

        var message: String {
            switch self {
            case .missingJoinUrl:
                return "Sliccstart \(followFlag): missing the join URL\n"
            case .invalidJoinUrl(let raw):
                return
                    "Sliccstart \(followFlag): \(raw) is not an http(s) join URL\n"
            case .missingPairId:
                return "Sliccstart \(followFlag): \(pairFlag) needs a value\n"
            }
        }
    }

    /// Recognise the headless computer modes anywhere in the process arguments
    /// (argv[0] is the executable path). Any other launch returns nil.
    ///
    /// Throws rather than falling through to the GUI on a malformed
    /// invocation: a typo'd flag that booted the menu-bar app would look to the
    /// CLI exactly like an outdated launcher, and the user would be told to
    /// update a Sliccstart that is already current.
    static func parse(_ argv: [String]) throws -> Request? {
        let args = Array(argv.dropFirst())
        if args.contains(preflightFlag) {
            return .preflight(json: args.contains(jsonFlag))
        }
        guard let followIndex = args.firstIndex(of: followFlag) else { return nil }

        let joinIndex = args.index(after: followIndex)
        guard joinIndex < args.endIndex else { throw ParseError.missingJoinUrl }
        let rawJoinUrl = args[joinIndex]
        guard isJoinUrl(rawJoinUrl) else { throw ParseError.invalidJoinUrl(rawJoinUrl) }

        return .follow(joinUrl: rawJoinUrl, pairId: try pairId(in: args))
    }

    /// The tray connector takes any URL it can parse, so the scheme is checked
    /// here instead — a `file:`/`javascript:` argument reaching a follower that
    /// exists to grant screen access is not a mistake worth being lenient with.
    static func isJoinUrl(_ raw: String) -> Bool {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return false }
        guard scheme == "https" || scheme == "http" else { return false }
        return !(url.host ?? "").isEmpty
    }

    private static func pairId(in args: [String]) throws -> String? {
        guard let flagIndex = args.firstIndex(of: pairFlag) else { return nil }
        let valueIndex = args.index(after: flagIndex)
        guard valueIndex < args.endIndex else { throw ParseError.missingPairId }
        let value = args[valueIndex]
        guard !value.isEmpty, !value.hasPrefix("--") else { throw ParseError.missingPairId }
        return value
    }

    // MARK: - Preflight reporting

    /// What TCC says about the two grants native driving needs.
    struct Grants: Codable, Equatable {
        /// Gates `computer.native.capture`.
        var screenRecording: Bool
        /// Gates `computer.native.input` — which also needs `--allow-input` and
        /// the leader's sudo approval hop before any event is injected.
        var accessibility: Bool

        var complete: Bool { screenRecording && accessibility }
    }

    /// Ask for both grants and report what came back.
    ///
    /// `request*` is preflight-then-prompt — it returns true immediately when
    /// the grant already exists — so this does not re-nag a configured Mac.
    /// Taking the probe as a parameter is what keeps the decision testable: the
    /// live one talks to TCC, and a test can stand in for it.
    static func resolveGrants(using probe: ComputerPermissionProbe) -> Grants {
        Grants(
            screenRecording: probe.screenRecordingGranted() || probe.requestScreenRecording(),
            accessibility: probe.accessibilityGranted() || probe.requestAccessibility())
    }

    /// The whole of `--computer-preflight` after `NSApplication` is up: ask,
    /// write the report, return the exit status. The streams are injected so
    /// the one untestable step left in the runner is the activation policy.
    static func preflight(
        using probe: ComputerPermissionProbe,
        json: Bool,
        writeOut: (Data) -> Void,
        writeErr: (Data) -> Void
    ) -> Int32 {
        let grants = resolveGrants(using: probe)
        do {
            writeOut(try report(grants, json: json))
        } catch {
            writeErr(Data("Sliccstart: failed to encode permission state\n".utf8))
            return 1
        }
        return exitCode(for: grants)
    }

    /// The exact bytes `--computer-preflight` writes to stdout.
    static func report(_ grants: Grants, json: Bool) throws -> Data {
        guard json else { return Data(describe(grants).utf8) }
        var data = try encode(grants)
        data.append(0x0A)
        return data
    }

    /// Wire shape shared with the Go CLI (`internal/computer.Grants`).
    static func encode(_ grants: Grants) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(grants)
    }

    /// Human-readable `--computer-preflight` output (no `--json`).
    static func describe(_ grants: Grants) -> String {
        var lines = [
            "Screen Recording: \(word(grants.screenRecording))",
            "Accessibility:    \(word(grants.accessibility))",
        ]
        if !grants.complete {
            // Naming the exact panes matters: these two live in different
            // sections of System Settings, and a grant given to the terminal
            // rather than to Sliccstart does nothing at all.
            lines.append("")
            lines.append(
                "Grant the missing ones to Sliccstart in System Settings ▸ Privacy & Security."
            )
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func word(_ granted: Bool) -> String { granted ? "granted" : "not granted" }

    /// Process exit status for a finished preflight.
    ///
    /// Distinct from 0 so a shell script can gate on it, but the CLI treats a
    /// partial grant as a warning: the user can tick the box in System Settings
    /// while the session runs, and the follower re-asks on its next capture.
    static func exitCode(for grants: Grants) -> Int32 { grants.complete ? 0 : 3 }

    /// Exit status for a malformed headless invocation.
    static let usageExitCode: Int32 = 2
}
