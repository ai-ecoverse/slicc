import AppKit
import SwiftUI
import XCTest

@testable import Sliccstart

@MainActor
final class SettingsViewRenderTests: XCTestCase {

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

    func testSettingsRendersAllFourTabs() {
        let view = SettingsView(fileProviderCoordinator: FileProviderCoordinator())
        XCTAssertFalse(ViewHosting.digest(of: view, width: 640, height: 460).isEmpty)
    }

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

    func testStartupTabRevealsTheDefaultBrowserSectionOnlyWithAutoLaunchOn() {

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

        XCTAssertTrue(
            FileProviderCoordinator(
                defaults: UserDefaults(suiteName: "sliccstart.tests.finder.unset")!
            ).isEnabled
        )
        XCTAssertFalse(off.isEnabled)
        XCTAssertTrue(on.isEnabled)

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

    func testTerminalsTabPreviewFollowsTheTemplate() {
        UserDefaults.standard.set(FollowCommandTemplate.defaultTemplate, forKey: terminalFollowCommandKey)
        let standard = ViewHosting.digest(of: TerminalsSettingsView(), width: 640, height: 440)
        UserDefaults.standard.set("{slicc} {joinUrl} follow --custom {shell}", forKey: terminalFollowCommandKey)
        let custom = ViewHosting.digest(of: TerminalsSettingsView(), width: 640, height: 440)

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

    private func secret(_ name: String, domains: [String] = ["example.com"]) -> Secret {
        Secret(name: name, value: "value-for-\(name)", domains: domains)
    }

    func testSecretsTabStaysLockedUntilUnlocked() {

        let locked = SecretsSettingsView(secrets: [secret("REAL_TOKEN")], unlocked: false)
        let unlocked = SecretsSettingsView(secrets: [secret("REAL_TOKEN")], unlocked: true)
        ViewHosting.assertRendersDifferently(locked, unlocked, width: 640, height: 440)
    }

    func testSecretsTabRendersAPopulatedUnlockedTable() {

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

    private func editor(
        draft: SecretDraft,
        existing: Set<String> = [],
        onSave: @escaping (Secret) -> Void = { _ in }
    ) -> SecretEditorSheet {
        SecretEditorSheet(draft: draft, existingNames: existing, onCancel: {}, onSave: onSave)
    }

    func testEditorDistinguishesCreatingFromEditing() {

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

    func testSetupProgressOffersRetryOnlyOnFailure() {

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
