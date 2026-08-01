import AppKit
import Darwin
import Security
import SliccTraySession
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "TraySessionCLI")

/// Thin, side-effecting glue for `Sliccstart --list-sessions`. Reads the real
/// iCloud store, runs the reveal-consent dialog, and writes JSON to stdout. All
/// decision logic lives in the pure `TraySessionCLI`; this file is deliberately
/// small because it cannot be unit-tested (AppKit, Security, iCloud, TTY).
enum TraySessionCLIRunner {
    static func run(_ request: TraySessionCLI.Request) -> Int32 {
        let sessions = TraySessionSyncStore().sessions

        if request.reveal, !authorizeReveal() {
            return 3
        }

        do {
            var data = try TraySessionCLI.encode(sessions, reveal: request.reveal)
            data.append(0x0A)
            FileHandle.standardOutput.write(data)
            return 0
        } catch {
            log.error("encode failed: \(error.localizedDescription, privacy: .public)")
            FileHandle.standardError.write(Data("Sliccstart: failed to encode sessions\n".utf8))
            return 1
        }
    }

    /// Resolve reveal consent: a remembered "always" wins; otherwise prompt when
    /// a GUI session exists, else deny with guidance.
    private static func authorizeReveal() -> Bool {
        let caller = callerIdentity()
        let key = TraySessionCLI.consentKey(
            signingIdentifier: caller.signingIdentifier,
            executablePath: caller.executablePath
        )
        let consentStore = RevealConsentStore()
        let gui = guiSessionAvailable()

        switch TraySessionCLI.outcome(stored: consentStore.load(forConsentKey: key), guiAvailable: gui) {
        case .allow:
            return true
        case .deny:
            FileHandle.standardError.write(Data(TraySessionCLI.deniedMessage(guiAvailable: gui).utf8))
            return false
        case .prompt:
            let (allow, persist) = TraySessionCLI.effect(of: promptForReveal(caller: caller))
            if let persist {
                consentStore.save(persist, forConsentKey: key)
            }
            if !allow {
                FileHandle.standardError.write(Data(TraySessionCLI.deniedMessage(guiAvailable: gui).utf8))
            }
            return allow
        }
    }

    private static func promptForReveal(caller: CallerIdentity) -> TraySessionCLI.PromptResult {
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApplication.shared.activate(ignoringOtherApps: true)

        let requester = TraySessionCLI.describeCaller(
            name: caller.name,
            pid: caller.pid,
            signingIdentifier: caller.signingIdentifier
        )
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Reveal SLICC session join URLs?"
        alert.informativeText = """
            \(requester) is requesting the secret join URLs for your active SLICC sessions.

            A join URL lets its holder attach as a follower and run commands on the \
            leader. Only allow this if you started the request.
            """
        for title in TraySessionCLI.buttonTitles {
            alert.addButton(withTitle: title)
        }
        return TraySessionCLI.promptResult(forButtonIndex: alert.runModal().rawValue)
    }

    // MARK: - Best-effort caller identity

    private struct CallerIdentity {
        let pid: Int32
        let name: String?
        let executablePath: String?
        let signingIdentifier: String?
    }

    private static func callerIdentity() -> CallerIdentity {
        let ppid = getppid()
        let path = executablePath(forPid: ppid)
        let name = path.map { ($0 as NSString).lastPathComponent }
        return CallerIdentity(
            pid: ppid,
            name: name,
            executablePath: path,
            signingIdentifier: signingIdentifier(forPid: ppid)
        )
    }

    private static func executablePath(forPid pid: pid_t) -> String? {
        // PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN) is a C macro Swift cannot
        // import from this SDK; inline its value.
        let maxSize = 4 * 1024
        var buffer = [CChar](repeating: 0, count: maxSize)
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        return length > 0 ? String(cString: buffer) : nil
    }

    private static func signingIdentifier(forPid pid: pid_t) -> String? {
        let attributes = [kSecGuestAttributePid: pid] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
            let guest = code
        else { return nil }

        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(guest, [], &staticCode) == errSecSuccess,
            let resolved = staticCode
        else { return nil }

        var infoRef: CFDictionary?
        guard
            SecCodeCopySigningInformation(resolved, SecCSFlags(rawValue: kSecCSSigningInformation), &infoRef)
                == errSecSuccess,
            let info = infoRef as? [String: Any]
        else { return nil }

        return info[kSecCodeInfoIdentifier as String] as? String
    }

    /// A GUI (Aqua) login session can present a modal; a headless/SSH session
    /// returns nil here, so reveal falls back to deny-with-guidance.
    private static func guiSessionAvailable() -> Bool {
        CGSessionCopyCurrentDictionary() != nil
    }
}
