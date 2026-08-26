import SliccTrayKit
import SwiftUI
import XCTest

@testable import SliccFollower

@MainActor
final class ChatPresentationStateTests: XCTestCase {

    func testShellOwnerSurvivesMultitaskingLayoutTransitions() throws {
        let steps = multitaskingSteps
        var constructedOwners: [ChatPresentationState] = []
        func makeState() -> ChatPresentationState {
            let state = ChatPresentationState()
            constructedOwners.append(state)
            return state
        }
        let appState = AppState()
        let inboundActions = InboundActionCoordinator()
        func root(for step: LayoutStep) -> AnyView {
            AnyView(
                ChatView(presentation: makeState())
                    .environment(\.horizontalSizeClass, step.sizeClass)
                    .environmentObject(appState)
                    .environmentObject(inboundActions)
                    .frame(width: step.width, height: 768)
            )
        }

        let initialStep = steps[0]
        let host = UIHostingController(rootView: root(for: initialStep))
        let window = UIWindow(
            frame: CGRect(x: 0, y: 0, width: initialStep.width, height: 768))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        render(window, host: host, step: initialStep)
        XCTAssertEqual(constructedOwners.count, 1, "ChatView must construct one shell owner")
        let owner = try XCTUnwrap(constructedOwners.first)
        let ownerIdentity = ObjectIdentifier(owner)
        owner.activeSurface = .browser
        // Set while another surface is open: the terminal has to stay mounted
        // behind the browser, and a resize must not be what tears it down.
        owner.terminalWasOpened = true
        owner.composerDraft = "Keep this unfinished thought"
        owner.stagedAttachments = [
            MessageAttachment(
                id: "staged-1", name: "photo.jpg", mimeType: "image/jpeg", size: 1_024,
                kind: .image, data: "AAAA")
        ]

        for (index, step) in steps.enumerated() {
            XCTAssertEqual(
                ShellLayout.mode(
                    horizontalSizeClass: step.sizeClass,
                    availableWidth: step.width),
                step.mode,
                "\(step.name) must exercise the expected adaptive branch")
            if index > 0 {
                host.rootView = root(for: step)
                render(window, host: host, step: step)
            }

            XCTAssertEqual(constructedOwners.count, 1, "\(step.name) must not construct branch state")
            XCTAssertEqual(ObjectIdentifier(constructedOwners[0]), ownerIdentity)
            XCTAssertEqual(owner.activeSurface, .browser, "\(step.name) lost the open surface")
            XCTAssertTrue(
                owner.terminalWasOpened,
                "\(step.name) would have detached the terminal surface and its scrollback")
            XCTAssertEqual(
                owner.composerDraft,
                "Keep this unfinished thought",
                "\(step.name) lost the composer draft")
            XCTAssertEqual(
                owner.stagedAttachments.map(\.id),
                ["staged-1"],
                "\(step.name) discarded a photo the user had already picked")
            // The transcript's scroll position is deliberately NOT part of
            // this preserved state any more. It used to ride on a
            // `ScrollPosition` bound to the transcript's `ScrollView`, and
            // restoring that binding's estimated offset across a container
            // resize is what threw a reader backwards through the history
            // (#2072). The transcript now uses `defaultScrollAnchor(.bottom)`,
            // which has nothing to hand across a subtree swap, so a
            // compact/regular transition re-opens at the newest message.
            // Follow-up: restore the reading position by message id instead.
        }
    }

    /// `terminalWasOpened` only preserves the *decision* to show a terminal.
    /// The surface, its scrollback, and a half-typed command live in the view
    /// model, so the shell owns that too: were it a `@StateObject` inside
    /// either shell, every crossing of the size-class boundary would swap in
    /// a blank terminal.
    func testTerminalKeepsItsTypedInputAcrossMultitaskingLayoutTransitions() async throws {
        let steps = multitaskingSteps
        let appState = AppState()
        let inboundActions = InboundActionCoordinator()
        let owner = ChatPresentationState(activeSurface: .term, terminalWasOpened: true)
        func root(for step: LayoutStep) -> AnyView {
            AnyView(
                ChatView(presentation: owner)
                    .environment(\.horizontalSizeClass, step.sizeClass)
                    .environmentObject(appState)
                    .environmentObject(inboundActions)
                    .frame(width: step.width, height: 768)
            )
        }

        let initialStep = steps[0]
        let host = UIHostingController(rootView: root(for: initialStep))
        let window = UIWindow(
            frame: CGRect(x: 0, y: 0, width: initialStep.width, height: 768))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        render(window, host: host, step: initialStep)

        let terminal = owner.terminal(client: appState.terminalClient)
        let terminalIdentity = ObjectIdentifier(terminal)
        // `start()` is driven by the on-screen `TerminalView`, so its banner
        // only reaches this model if the view really is observing the shell's
        // model rather than one of its own. Without this the rest of the test
        // would just be re-checking that a memoized getter memoizes.
        let started = await settle(until: {
            terminal.accessibilityTranscript.contains("Sliccy leader terminal")
        })
        XCTAssertTrue(started, "the mounted TerminalView never started the shell's model")

        terminal.setConnectionAvailable(true)
        terminal.receiveInput(Data("echo half-typed".utf8))
        XCTAssertTrue(
            terminal.accessibilityTranscript.contains("half-typed"),
            "the terminal has to echo the typed command before the walk proves anything")

        for step in steps.dropFirst() {
            host.rootView = root(for: step)
            render(window, host: host, step: step)

            XCTAssertEqual(
                ObjectIdentifier(owner.terminal(client: appState.terminalClient)),
                terminalIdentity,
                "\(step.name) rebuilt the terminal instead of re-parenting it")
            XCTAssertTrue(
                terminal.accessibilityTranscript.contains("half-typed"),
                "\(step.name) lost the half-typed command")
        }
    }

    /// The Ghostty surface materializes over a few run-loop turns, so poll
    /// rather than assume a fixed delay is enough on a loaded CI machine.
    private func settle(
        until condition: @MainActor () -> Bool,
        timeout: TimeInterval = 5
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
            await Task.yield()
        }
        return condition()
    }

    private func render(
        _ window: UIWindow,
        host: UIHostingController<AnyView>,
        step: LayoutStep
    ) {
        window.frame = CGRect(x: 0, y: 0, width: step.width, height: 768)
        host.view.frame = window.bounds
        window.setNeedsLayout()
        window.layoutIfNeeded()
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
    }
}

/// Slide Over through Full Screen and back, crossing the 560pt boundary in
/// both directions so a transition that only breaks one way cannot hide.
private let multitaskingSteps: [LayoutStep] = [
    .init(name: "Slide Over", sizeClass: .compact, width: 320, mode: .compactOverlay),
    .init(name: "Split View at boundary", sizeClass: .regular, width: 560, mode: .compactOverlay),
    .init(name: "Split View above boundary", sizeClass: .regular, width: 561, mode: .regularSplit),
    .init(name: "Full Screen", sizeClass: .regular, width: 1_024, mode: .regularSplit),
    .init(name: "Back above boundary", sizeClass: .regular, width: 561, mode: .regularSplit),
    .init(name: "Back at boundary", sizeClass: .regular, width: 560, mode: .compactOverlay),
    .init(name: "Back to Slide Over", sizeClass: .compact, width: 320, mode: .compactOverlay),
]

private struct LayoutStep {
    let name: String
    let sizeClass: UserInterfaceSizeClass
    let width: CGFloat
    let mode: ShellLayoutMode
}
