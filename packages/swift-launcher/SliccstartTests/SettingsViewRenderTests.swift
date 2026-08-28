import AppKit
import SwiftUI
import XCTest

@testable import Sliccstart

/// The four Settings tabs, driven through real (off-screen) SwiftUI renders.
///
/// Each tab is mostly conditional `body`: the mount table's empty overlay and
/// its per-row validation warning, the startup tab's default-browser section,
/// the terminals tab's live preview, the secrets tab's locked/unlocked split
/// and its editor's validation states. Rendering each state and comparing the
/// results is the only way to reach that code from a test (see `ViewHosting`
/// for why interaction is not available headless).
@MainActor
final class SettingsViewRenderTests: XCTestCase {

    /// Every `@AppStorage` key these tabs bind to, saved and restored so a
    /// test's seeded value cannot leak into another test — or into the
    /// developer's real preferences.
    private static let touchedDefaults = [
        StartupPreference.enabledKey,
        terminalFollowCommandKey,
        suppressTerminalWarningKey,
        MountTablePreference.key,
    ]
    private var savedDefaults: [String: Any] = [:]

    override func setUp() {
        super.setUp()
        for key in Self.touchedDefaults {
            savedDefaults[key] = UserDefaults.standard.object(forKey: key)
        }
    }

    override func tearDown() {
        for key in Self.touchedDefaults {
            if let value = savedDefaults[key] {
                UserDefaults.standard.set(value, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
        savedDefaults = [:]
        super.tearDown()
    }

    // MARK: - Tab container

    func testSettingsRendersAllFourTabs() {
        let view = SettingsView(fileProviderCoordinator: FileProviderCoordinator())
        XCTAssertFalse(ViewHosting.digest(of: view, width: 640, height: 460).isEmpty)
    }

    // MARK: - Mounts

    /// The drop hint is an `.overlay` on a `Table`, and how much of that
    /// subtree an off-screen render produces is an OS-version detail: on
    /// macOS 26 the empty and populated tabs render differently, on the
    /// macOS 15 CI runner they are byte-identical. Asserting the difference
    /// passed locally and failed in CI, which makes it a worse test than no
    /// test — so this only says both states build, and the condition itself
    /// (`rows.isEmpty`) is plain enough to read.
    func testMountsTabBuildsEmptyAndPopulated() {
        XCTAssertFalse(
            ViewHosting.digest(of: MountsSettingsView(), width: 640, height: 400).isEmpty
        )
        XCTAssertFalse(
            ViewHosting.digest(
                of: MountsSettingsView(rows: [
                    MountsSettingsView.Row(path: "/mnt/code", hostPath: "/Users/test/code")
                ]),
                width: 640,
                height: 400
            ).isEmpty
        )
    }

    /// `Table` is `NSTableView`-backed and draws nothing under `ImageRenderer`,
    /// so a row's own cells (the path field, the warning triangle, the folder
    /// column) cannot be reached this way — only the table's presence and the
    /// empty-state overlay can. The rules those cells display are asserted
    /// against `MountTablePreference` directly, which is where they live.
    func testMountRowRulesTheTableDisplays() {
        XCTAssertTrue(MountTablePreference.isValidTarget("/mnt/code", among: ["/mnt/code"]))
        XCTAssertFalse(MountTablePreference.isValidTarget("not-absolute", among: ["not-absolute"]))
        XCTAssertFalse(
            MountTablePreference.isValidTarget("/mnt/dup", among: ["/mnt/dup", "/mnt/dup"]),
            "two rows mounting the same target is not a usable table"
        )
        XCTAssertFalse(MountTablePreference.displayPath("/Users/test/code").isEmpty)
    }

    func testMountsTabRendersARowWithoutCrashingOnAnEmptyFolder() {
        // A row whose folder has not been chosen yet is a UI-only row that is
        // never persisted; it still has to render.
        XCTAssertFalse(
            ViewHosting.digest(
                of: MountsSettingsView(rows: [
                    MountsSettingsView.Row(path: "/mnt/code", hostPath: ""),
                    MountsSettingsView.Row(path: "/mnt/other", hostPath: "/Users/test/other"),
                ]),
                width: 640,
                height: 400
            ).isEmpty
        )
    }

    // MARK: - Startup

    func testStartupTabRevealsTheDefaultBrowserSectionOnlyWithAutoLaunchOn() {
        // The role is only offered alongside auto-launch: as the default
        // browser Sliccstart hands every link to the leader, which has to be
        // running for the link to have anywhere to go.
        UserDefaults.standard.set(false, forKey: StartupPreference.enabledKey)
        let off = ViewHosting.digest(
            of: StartupSettingsView(fileProviderCoordinator: FileProviderCoordinator()),
            width: 480,
            height: 420
        )
        UserDefaults.standard.set(true, forKey: StartupPreference.enabledKey)
        let on = ViewHosting.digest(
            of: StartupSettingsView(fileProviderCoordinator: FileProviderCoordinator()),
            width: 480,
            height: 420
        )
        XCTAssertNotEqual(off, on)
    }

    func testStartupTabReflectsTheFinderIntegrationToggle() {
        // Read through injected defaults rather than the `isEnabled` setter:
        // the setter registers/removes a real File Provider domain, which a
        // unit test has no business doing to the machine it runs on.
        let coordinator = { (enabled: Bool) -> FileProviderCoordinator in
            let suite = UserDefaults(suiteName: "sliccstart.tests.finder.\(enabled)")!
            suite.set(enabled, forKey: FileProviderCoordinator.enabledKey)
            return FileProviderCoordinator(defaults: suite)
        }
        addTeardownBlock {
            for name in ["sliccstart.tests.finder.true", "sliccstart.tests.finder.false"] {
                UserDefaults.standard.removePersistentDomain(forName: name)
            }
        }
        let off = coordinator(false)
        let on = coordinator(true)

        // Finder integration defaults to ON for a fresh install, so an absent
        // preference must not read as "off" — that would silently unmount a
        // user who never touched the setting.
        XCTAssertTrue(
            FileProviderCoordinator(
                defaults: UserDefaults(suiteName: "sliccstart.tests.finder.unset")!
            ).isEnabled
        )
        XCTAssertFalse(off.isEnabled)
        XCTAssertTrue(on.isEnabled)

        // Both states have to build; the switch itself is AppKit-backed and
        // draws nothing under `ImageRenderer`, so its knob cannot be asserted
        // on here (same limitation as `Table`).
        XCTAssertFalse(
            ViewHosting.digest(
                of: StartupSettingsView(fileProviderCoordinator: off),
                width: 520,
                height: 760
            ).isEmpty
        )
        XCTAssertFalse(
            ViewHosting.digest(
                of: StartupSettingsView(fileProviderCoordinator: on),
                width: 520,
                height: 760
            ).isEmpty
        )
    }

    // MARK: - Terminals

    func testTerminalsTabPreviewFollowsTheTemplate() {
        UserDefaults.standard.set(FollowCommandTemplate.defaultTemplate, forKey: terminalFollowCommandKey)
        let standard = ViewHosting.digest(of: TerminalsSettingsView(), width: 640, height: 440)
        UserDefaults.standard.set("{slicc} {joinUrl} follow --custom {shell}", forKey: terminalFollowCommandKey)
        let custom = ViewHosting.digest(of: TerminalsSettingsView(), width: 640, height: 440)
        // The preview is the whole point of the tab: an edited template that
        // did not change it would be a silently broken editor.
        XCTAssertNotEqual(standard, custom)
    }

    func testTerminalsTabEnablesRestoreOnlyForAnEditedTemplate() {
        UserDefaults.standard.set(FollowCommandTemplate.defaultTemplate, forKey: terminalFollowCommandKey)
        let pristine = ViewHosting.digest(of: TerminalsSettingsView(), width: 640, height: 440)
        UserDefaults.standard.set("{slicc} {joinUrl} follow {shell}", forKey: terminalFollowCommandKey)
        let edited = ViewHosting.digest(of: TerminalsSettingsView(), width: 640, height: 440)
        XCTAssertNotEqual(pristine, edited)
    }

    func testTerminalsTabEnablesShowWarningAgainOnlyWhileSuppressed() {
        UserDefaults.standard.set(FollowCommandTemplate.defaultTemplate, forKey: terminalFollowCommandKey)
        UserDefaults.standard.set(false, forKey: suppressTerminalWarningKey)
        let notSuppressed = ViewHosting.digest(of: TerminalsSettingsView(), width: 640, height: 440)
        UserDefaults.standard.set(true, forKey: suppressTerminalWarningKey)
        let suppressed = ViewHosting.digest(of: TerminalsSettingsView(), width: 640, height: 440)
        XCTAssertNotEqual(notSuppressed, suppressed)
    }

    // MARK: - Secrets

    private func secret(_ name: String, domains: [String] = ["example.com"]) -> Secret {
        Secret(name: name, value: "value-for-\(name)", domains: domains)
    }

    func testSecretsTabStaysLockedUntilUnlocked() {
        // Locked shows blurred placeholders and never the real names, so the
        // two states must not render the same.
        let locked = SecretsSettingsView(secrets: [secret("REAL_TOKEN")], unlocked: false)
        let unlocked = SecretsSettingsView(secrets: [secret("REAL_TOKEN")], unlocked: true)
        ViewHosting.assertRendersDifferently(locked, unlocked, width: 640, height: 440)
    }

    func testSecretsTabRendersAPopulatedUnlockedTable() {
        // Table cells themselves are NSTableView-backed and invisible to
        // `ImageRenderer` (see the mounts note above), so this asserts the tab
        // builds around them rather than what a row draws.
        XCTAssertFalse(
            ViewHosting.digest(
                of: SecretsSettingsView(
                    secrets: [secret("A"), secret("B", domains: ["api.github.com", "*.github.com"])],
                    unlocked: true,
                    selection: secret("A").id
                ),
                width: 640,
                height: 440
            ).isEmpty
        )
    }

    // MARK: - Secret editor

    private func editor(
        draft: SecretDraft,
        existing: Set<String> = [],
        onSave: @escaping (Secret) -> Void = { _ in }
    ) -> SecretEditorSheet {
        SecretEditorSheet(draft: draft, existingNames: existing, onCancel: {}, onSave: onSave)
    }

    func testEditorDistinguishesCreatingFromEditing() {
        // An edit draft normally seeds name/value/domains too, so comparing it
        // against a fresh sheet would still differ with the title made
        // identical. Edit an *empty* secret: the fields then match a new sheet
        // exactly and the heading is the only thing left to move.
        let blank = Secret(name: "", value: "", domains: [])
        ViewHosting.assertRendersDifferently(
            editor(draft: .creating),
            editor(draft: .editing(blank)),
            "the sheet must say whether it is creating or editing",
            width: 540,
            height: 420
        )
    }

    func testEditorSurfacesEachValidationFailure() {
        // Most of these are only reachable by typing into the sheet, which an
        // off-screen render cannot do — so they are asserted against the rule
        // the sheet displays. Rendering only the empty and complete drafts (as
        // this test first did) left every message in between unexercised.
        func message(
            name: String = "TOKEN",
            value: String = "secret",
            domains: [String] = ["api.example.com"],
            draft: SecretDraft = .creating,
            existing: Set<String> = []
        ) -> String? {
            SecretEditorSheet.validationMessage(
                name: name,
                value: value,
                domainPatterns: domains,
                draft: draft,
                existingNames: existing
            )
        }

        XCTAssertNil(message(), "a complete draft is saveable")
        XCTAssertNil(message(name: "  TOKEN  "), "surrounding whitespace is trimmed, not rejected")
        XCTAssertEqual(message(name: ""), "Name is required.")
        XCTAssertEqual(message(name: "   "), "Name is required.")
        XCTAssertEqual(
            message(name: "has space"),
            "Name may only contain letters, numbers, dots, underscores, and hyphens."
        )
        XCTAssertEqual(
            message(name: "TOKEN", existing: ["TOKEN"]),
            "A secret named \"TOKEN\" already exists."
        )
        XCTAssertEqual(message(value: ""), "Value is required.")
        XCTAssertEqual(message(domains: []), "Add at least one hostname pattern.")
        XCTAssertEqual(
            message(domains: ["   ", ""]),
            "Add at least one hostname pattern.",
            "blank rows are not hostnames"
        )
        XCTAssertEqual(
            message(domains: ["api.example.com", "not a host"]),
            "\"not a host\" is not a valid hostname pattern. Use `example.com`, `*.example.com`, or `*`."
        )
    }

    func testRenamingAnExistingSecretOntoItselfIsNotACollision() {
        // Editing GITHUB_TOKEN and leaving the name alone must stay saveable
        // even though that name is, of course, already taken.
        let stored = secret("GITHUB_TOKEN")
        XCTAssertNil(
            SecretEditorSheet.validationMessage(
                name: "GITHUB_TOKEN",
                value: "v",
                domainPatterns: ["api.github.com"],
                draft: .editing(stored),
                existingNames: ["GITHUB_TOKEN", "OTHER"]
            )
        )
        // ...but renaming it onto another secret's name is.
        XCTAssertEqual(
            SecretEditorSheet.validationMessage(
                name: "OTHER",
                value: "v",
                domainPatterns: ["api.github.com"],
                draft: .editing(stored),
                existingNames: ["GITHUB_TOKEN", "OTHER"]
            ),
            "A secret named \"OTHER\" already exists."
        )
    }

    func testTheEditorShowsAValidationMessageWhenThereIsOne() {
        // The render side of the same rule: an incomplete draft and a complete
        // one differ, and the only field varied is the value.
        let incomplete = Secret(name: "TOKEN", value: "", domains: ["api.example.com"])
        let complete = Secret(name: "TOKEN", value: "v", domains: ["api.example.com"])
        ViewHosting.assertRendersDifferently(
            editor(draft: .editing(incomplete)),
            editor(draft: .editing(complete)),
            "a draft that cannot be saved must say why",
            width: 540,
            height: 420
        )
    }

    func testEditorRendersASecretWithNoHostnamesAsOneEmptyRow() {
        // `domains: []` must still offer a row to type into, otherwise the
        // sheet is unusable and can never satisfy its own save rule. Comparing
        // against a *populated* draft proved nothing (the text differs anyway);
        // comparing against an explicitly-blank row pins the fallback: the two
        // must be indistinguishable.
        let noDomains = editor(draft: .editing(secret("TOKEN", domains: [])))
        let oneBlankDomain = editor(draft: .editing(secret("TOKEN", domains: [""])))
        XCTAssertEqual(
            ViewHosting.digest(of: noDomains, width: 540, height: 420),
            ViewHosting.digest(of: oneBlankDomain, width: 540, height: 420),
            "a secret with no hostnames must render exactly like one blank row"
        )
    }

    func testEditorGrowsWithEachHostnamePattern() {
        let one = editor(draft: .editing(secret("TOKEN", domains: ["a.example.com"])))
        let two = editor(draft: .editing(secret("TOKEN", domains: ["a.example.com", "b.example.com"])))
        ViewHosting.assertRendersDifferently(one, two, width: 540, height: 460)
    }

    func testSecretDraftIdentitySeparatesNewFromEdited() {
        XCTAssertEqual(SecretDraft.creating.id, "__new__")
        XCTAssertEqual(SecretDraft.editing(secret("A")).id, "edit:A")
        XCTAssertNotEqual(SecretDraft.creating.id, SecretDraft.editing(secret("A")).id)
    }

    // MARK: - Setup progress

    func testSetupProgressOffersRetryOnlyOnFailure() {
        // Hold the message and the spinner constant: `error` is then the only
        // input left, so the Retry button is the only thing that can differ.
        // (Varying all three, as this first did, passed with Retry deleted.)
        let row = { (error: String?) in
            SetupProgressView(
                message: "Installing…",
                isWorking: true,
                error: error,
                onRetry: {}
            )
        }
        ViewHosting.assertRendersDifferently(
            row(nil),
            row("boom"),
            "a failed setup must offer Retry",
            width: 420,
            height: 260
        )
    }

    func testSetupProgressShowsItsSpinnerOnlyWhileWorking() {
        let row = { (isWorking: Bool) in
            SetupProgressView(message: "Installing…", isWorking: isWorking, error: nil, onRetry: {})
        }
        ViewHosting.assertRendersDifferently(row(false), row(true), width: 420, height: 260)
    }
}
