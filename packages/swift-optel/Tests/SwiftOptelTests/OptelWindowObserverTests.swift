import XCTest
@testable import SwiftOptel

final class OptelWindowObserverTests: XCTestCase {
    // MARK: - OptelWindowIdentity.make

    func testIdentityPrefersTitleAsSourceWhenPresent() {
        let identity = OptelWindowIdentity.make(
            identifier: "main-window",
            title: "Sliccstart",
            fallbackKey: "0xDEAD"
        )
        XCTAssertEqual(identity.source, "Sliccstart")
        // Identifier wins as the stable key even when title is the visible source.
        XCTAssertEqual(identity.key, "id:main-window")
    }

    func testIdentityFallsBackToIdentifierAsSourceWhenTitleIsBlank() {
        let identity = OptelWindowIdentity.make(
            identifier: "settings-window",
            title: "   ",
            fallbackKey: "0xCAFE"
        )
        XCTAssertEqual(identity.source, "settings-window")
        XCTAssertEqual(identity.key, "id:settings-window")
    }

    func testIdentityFallsBackToTitleKeyWhenIdentifierIsBlank() {
        let identity = OptelWindowIdentity.make(
            identifier: nil,
            title: "Inspector",
            fallbackKey: "0xBEEF"
        )
        XCTAssertEqual(identity.source, "Inspector")
        // When there is no explicit identifier, the per-window fallbackKey is
        // folded into the dedupe key so two windows with the same title but
        // different object identities are not collapsed into one.
        XCTAssertEqual(identity.key, "title:Inspector#ref:0xBEEF")
    }

    func testIdentityFallsBackToProvidedRefWhenIdAndTitleAreBlank() {
        let identity = OptelWindowIdentity.make(
            identifier: "",
            title: "",
            fallbackKey: "0xFEED"
        )
        XCTAssertEqual(identity.source, "window")
        XCTAssertEqual(identity.key, "ref:0xFEED")
    }

    func testIdentityKeysDistinguishBlankWindowsByFallback() {
        let a = OptelWindowIdentity.make(identifier: nil, title: nil, fallbackKey: "A")
        let b = OptelWindowIdentity.make(identifier: nil, title: nil, fallbackKey: "B")
        XCTAssertNotEqual(a.key, b.key)
    }

    func testIdentityKeysDistinguishSameTitleWindowsByFallback() {
        // Two distinct NSWindow objects with no identifier and the same
        // non-empty title (duplicate document windows) must produce distinct
        // dedupe keys; otherwise switching between them would be treated as
        // re-focusing the same window and `navigate` would never emit.
        let first = OptelWindowIdentity.make(
            identifier: nil,
            title: "Untitled",
            fallbackKey: "0xAAA"
        )
        let second = OptelWindowIdentity.make(
            identifier: nil,
            title: "Untitled",
            fallbackKey: "0xBBB"
        )
        XCTAssertNotEqual(first.key, second.key)
        // Source still prefers the title for human readability.
        XCTAssertEqual(first.source, "Untitled")
        XCTAssertEqual(second.source, "Untitled")

        let decision = OptelWindowNavigateDecider.decide(previous: first, current: second)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "Untitled")
    }

    func testIdentityKeyStableAcrossReFocusOfSameWindow() {
        // Re-observing the same window object (same fallbackKey, same title,
        // no identifier) must produce the same key so the decider treats it
        // as a re-focus and skips emission.
        let first = OptelWindowIdentity.make(
            identifier: nil,
            title: "Untitled",
            fallbackKey: "0xSAME"
        )
        let second = OptelWindowIdentity.make(
            identifier: nil,
            title: "Untitled",
            fallbackKey: "0xSAME"
        )
        XCTAssertEqual(first.key, second.key)
        let decision = OptelWindowNavigateDecider.decide(previous: first, current: second)
        XCTAssertFalse(decision.shouldEmit)
    }

    func testIdentityKeyIgnoresFallbackWhenIdentifierPresent() {
        // When an explicit identifier exists, the key is identifier-based and
        // does NOT depend on the fallback. Two observations of the same
        // logical window with the same identifier collapse to one key even
        // if the underlying object identities differ.
        let first = OptelWindowIdentity.make(
            identifier: "main-window",
            title: "Sliccstart",
            fallbackKey: "0xAAA"
        )
        let second = OptelWindowIdentity.make(
            identifier: "main-window",
            title: "Sliccstart",
            fallbackKey: "0xBBB"
        )
        XCTAssertEqual(first.key, "id:main-window")
        XCTAssertEqual(second.key, "id:main-window")
    }

    // MARK: - OptelWindowNavigateDecider.decide

    func testFirstWindowEmits() {
        let current = OptelWindowIdentity(key: "id:A", source: "Window A")
        let decision = OptelWindowNavigateDecider.decide(previous: nil, current: current)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "Window A")
    }

    func testReFocusingSameWindowDoesNotEmit() {
        let identity = OptelWindowIdentity(key: "id:A", source: "Window A")
        let decision = OptelWindowNavigateDecider.decide(previous: identity, current: identity)
        XCTAssertFalse(decision.shouldEmit)
        XCTAssertNil(decision.source)
    }

    func testSwitchingWindowsEmitsNewSource() {
        let previous = OptelWindowIdentity(key: "id:A", source: "Window A")
        let current = OptelWindowIdentity(key: "id:B", source: "Window B")
        let decision = OptelWindowNavigateDecider.decide(previous: previous, current: current)
        XCTAssertTrue(decision.shouldEmit)
        XCTAssertEqual(decision.source, "Window B")
    }

    func testKeyComparisonIgnoresDisplaySourceChanges() {
        // Same underlying window (same key) re-reported with a renamed title
        // should not emit again — `key`, not `source`, drives the dedupe.
        let previous = OptelWindowIdentity(key: "id:A", source: "Window A")
        let renamed = OptelWindowIdentity(key: "id:A", source: "Window A (modified)")
        let decision = OptelWindowNavigateDecider.decide(previous: previous, current: renamed)
        XCTAssertFalse(decision.shouldEmit)
    }

    // MARK: - macOS observer install/uninstall

    #if os(macOS)
    func testObserverInstallIsIdempotent() {
        OptelWindowObserver._testing_reset()
        XCTAssertFalse(OptelWindowObserver.isInstalled)
        OptelWindowObserver.installIfNeeded()
        XCTAssertTrue(OptelWindowObserver.isInstalled)
        // Second call is a no-op; flag remains set and no crash.
        OptelWindowObserver.installIfNeeded()
        XCTAssertTrue(OptelWindowObserver.isInstalled)
        OptelWindowObserver.uninstall()
        XCTAssertFalse(OptelWindowObserver.isInstalled)
        // Uninstall when nothing is installed is also a no-op.
        OptelWindowObserver.uninstall()
        XCTAssertFalse(OptelWindowObserver.isInstalled)
    }
    #endif
}
