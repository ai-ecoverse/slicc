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

    func testMountsTabShowsTheDropHintOnlyWhileEmpty() {
        ViewHosting.assertRendersDifferently(
            MountsSettingsView(),
            MountsSettingsView(rows: [
                MountsSettingsView.Row(path: "/mnt/code", hostPath: "/Users/test/code")
            ]),
            "an empty mount table must show its drop hint",
            width: 640,
            height: 400
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
        ViewHosting.assertRendersDifferently(
            editor(draft: .creating),
            editor(draft: .editing(secret("GITHUB_TOKEN"))),
            "the sheet must say whether it is creating or editing",
            width: 540,
            height: 420
        )
    }

    func testEditorSurfacesEachValidationFailure() {
        // A fresh sheet is empty (name required); an edited secret is complete.
        // Every message in between is a distinct branch of `validationMessage`.
        let empty = ViewHosting.digest(of: editor(draft: .creating), width: 540, height: 420)
        let complete = ViewHosting.digest(
            of: editor(draft: .editing(secret("GITHUB_TOKEN"))),
            width: 540,
            height: 420
        )
        XCTAssertNotEqual(empty, complete)

        // The same rules the sheet renders, asserted directly.
        XCTAssertFalse(SecretNameValidator.isValid(""))
        XCTAssertFalse(SecretNameValidator.isValid("has space"))
        XCTAssertTrue(SecretNameValidator.isValid("s3.prod.key"))
        XCTAssertFalse(EnvFileFormat.isValidHostnamePattern("not a host"))
        XCTAssertTrue(EnvFileFormat.isValidHostnamePattern("*.example.com"))
    }

    func testEditorRendersASecretWithNoHostnamesAsOneEmptyRow() {
        // `domains: []` must still offer a row to type into, otherwise the
        // sheet is unusable and can never satisfy its own save rule.
        let noDomains = editor(draft: .editing(secret("TOKEN", domains: [])))
        let oneDomain = editor(draft: .editing(secret("TOKEN", domains: ["example.com"])))
        ViewHosting.assertRendersDifferently(noDomains, oneDomain, width: 540, height: 420)
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

    func testSetupProgressCoversWorkingAndFailedStates() {
        let working = SetupProgressView(message: "Installing…", isWorking: true, error: nil, onRetry: {})
        let failed = SetupProgressView(message: "Install failed", isWorking: false, error: "boom", onRetry: {})
        ViewHosting.assertRendersDifferently(
            working,
            failed,
            "a failed setup must offer Retry instead of a spinner",
            width: 420,
            height: 260
        )
    }
}
