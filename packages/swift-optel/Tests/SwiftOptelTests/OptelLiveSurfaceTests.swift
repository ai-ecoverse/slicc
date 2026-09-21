#if os(macOS)
    import AppKit
    import SwiftUI
    import XCTest

    @testable import SwiftOptel

    private struct FixedRandomSource: RandomSource {
        let value: Double
        func nextUnitDouble() -> Double { value }
    }

    /// Hosts SwiftUI views and drives AppKit windows so modifier `body` paths,
    /// `NSView` accessibility adapters, and the live click/window hooks run.
    @available(macOS 13.0, *)
    final class OptelLiveSurfaceTests: XCTestCase {
        override func setUp() {
            super.setUp()
            _ = NSApplication.shared
        }

        override func tearDown() {
            OptelClickMonitor._testing_reset()
            OptelWindowObserver._testing_reset()
            OptelUncaughtExceptionHook._testing_reset()
            super.tearDown()
        }

        private func configureRecordingOptel() -> RecordingTransport {
            let transport = RecordingTransport()
            Optel.shared.configure(
                appID: "com.example.live",
                rate: "on",
                collectBaseURL: URL(string: "https://rum.hlx.page/")!,
                transport: transport,
                randomSource: FixedRandomSource(value: 0)
            )
            return transport
        }

        private func makeWindow(
            title: String = "Live",
            identifier: String = "live-window"
        ) -> NSWindow {
            let button = NSButton(title: "Go", target: nil, action: nil)
            button.frame = NSRect(x: 8, y: 8, width: 80, height: 24)
            button.setAccessibilityIdentifier("go")
            button.setAccessibilityLabel("Go")
            let content = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 80))
            content.addSubview(button)
            let window = NSWindow(
                contentRect: content.frame,
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.title = title
            window.identifier = NSUserInterfaceItemIdentifier(identifier)
            window.isReleasedWhenClosed = false
            window.contentView = content
            window.makeKeyAndOrderFront(nil)
            return window
        }

        private func pump(_ seconds: TimeInterval = 0.2) {
            RunLoop.current.run(until: Date().addingTimeInterval(seconds))
        }

        // MARK: - SwiftUI view surface

        func testViewExtensionsAndButtonBodiesEvaluateWhenHosted() {
            _ = configureRecordingOptel()
            let root =
                VStack {
                    Text("screen").optelView("home")
                    Text("tap-me").optelTap(source: "panel view#detail")
                    OptelButton(identifier: "ok", accessibilityLabel: "OK", context: "form") {
                    } label: {
                        Text("OK")
                    }
                    OptelButton("Save", identifier: "save", context: "form") {}
                }
                .optelAutoInstrument(appID: "com.example.live", rate: "on", globalHooks: false)
            let controller = NSHostingController(rootView: root)
            controller.view.frame = NSRect(x: 0, y: 0, width: 240, height: 160)
            let window = NSWindow(
                contentRect: controller.view.frame,
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentViewController = controller
            window.makeKeyAndOrderFront(nil)
            controller.view.layoutSubtreeIfNeeded()
            pump()
            XCTAssertGreaterThan(controller.view.fittingSize.width, 0)
            pressAll(in: controller.view)
            pump()
            window.close()
        }

        func testScenePhaseOnChangeRefiresEnter() {
            let transport = configureRecordingOptel()
            let box = ScenePhaseBox()
            let controller = NSHostingController(
                rootView: ScenePhaseHost(box: box).environment(\.scenePhase, box.phase))
            controller.view.frame = NSRect(x: 0, y: 0, width: 120, height: 40)
            let window = NSWindow(
                contentRect: controller.view.frame,
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentViewController = controller
            window.makeKeyAndOrderFront(nil)
            pump()
            box.phase = .background
            controller.view.needsLayout = true
            pump()
            box.phase = .active
            pump()
            window.close()
            _ = transport.sent
        }

        // MARK: - AppKit adapters + live hooks

        func testNSViewAccessibilityAdapterAndWindowIdentity() throws {
            let window = makeWindow(title: "Adapter", identifier: "adapter")
            defer { window.close() }
            let button = window.contentView?.subviews.first as? NSButton
            let view = try XCTUnwrap(button)
            XCTAssertEqual(view.optelAccessibilityIdentifier, "go")
            XCTAssertEqual(view.optelAccessibilityLabel, "Go")
            let untitled = NSView(frame: .zero)
            untitled.setAccessibilityLabel("")
            untitled.setAccessibilityTitle("TitleOnly")
            XCTAssertEqual(untitled.optelAccessibilityLabel, "TitleOnly")
            XCTAssertEqual(view.optelAccessibilityWindowTitle, "Adapter")
            XCTAssertNotNil(view.optelAccessibilityParent)
            _ = view.optelAccessibilityRole
            let identity = OptelWindowObserver.identity(for: window)
            XCTAssertEqual(identity.source, "Adapter")
        }

        func testWindowObserverHandleEmitsNavigateAndIgnoresNonWindowNotifications() {
            let transport = configureRecordingOptel()
            OptelWindowObserver._testing_reset()
            OptelWindowObserver.installIfNeeded()
            NotificationCenter.default.post(
                name: NSWindow.didBecomeKeyNotification, object: "not-a-window")
            pump()
            let before = transport.sent.count
            let window = makeWindow(title: "Navigator", identifier: "nav-1")
            OptelWindowObserver.handle(window: window)
            NotificationCenter.default.post(
                name: NSWindow.didBecomeMainNotification, object: window)
            pump()
            let navigates = transport.sent.filter { $0.event.checkpoint.rawValue == "navigate" }
            XCTAssertFalse(navigates.isEmpty)
            XCTAssertGreaterThanOrEqual(transport.sent.count, before)
            window.close()
            OptelWindowObserver.uninstall()
        }

        func testClickMonitorHandleEmitsAndSkipsEventsWithoutAWindow() {
            let transport = configureRecordingOptel()
            let stray = NSEvent.mouseEvent(
                with: .leftMouseUp,
                location: .zero,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: 0,
                context: nil,
                eventNumber: 1,
                clickCount: 1,
                pressure: 1
            )
            if let stray {
                OptelClickMonitor.handle(event: stray)
            }

            let window = makeWindow()
            defer { window.close() }
            let location = NSPoint(x: 40, y: 20)
            let event = NSEvent.mouseEvent(
                with: .leftMouseUp,
                location: location,
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: 2,
                clickCount: 1,
                pressure: 1
            )
            OptelClickMonitor.installIfNeeded()
            if let event {
                OptelClickMonitor.handle(event: event)
                NSApp.sendEvent(event)
            }
            let exp = expectation(description: "deferred click")
            DispatchQueue.main.async { exp.fulfill() }
            wait(for: [exp], timeout: 1)
            let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
            XCTAssertFalse(clicks.isEmpty)
        }

        func testSystemRandomSourceProducesUnitInterval() {
            let rng = SystemRandomSource()
            for _ in 0..<8 {
                let value = rng.nextUnitDouble()
                XCTAssertGreaterThanOrEqual(value, 0)
                XCTAssertLessThan(value, 1)
            }
        }

        func testSharedReportErrorAndExceptionTrampoline() {
            let transport = configureRecordingOptel()
            enum Boom: Error { case fail }
            Optel.reportError(Boom.fail)
            let exception = NSException(
                name: NSExceptionName("OptelLiveException"),
                reason: "from-trampoline",
                userInfo: nil
            )
            OptelUncaughtExceptionHook.installIfNeeded()
            OptelUncaughtExceptionHook._testing_invokeTrampoline(exception)
            let errors = transport.sent.filter { $0.event.checkpoint.rawValue == "error" }
            XCTAssertGreaterThanOrEqual(errors.count, 2)
        }

        private func pressAll(in view: NSView) {
            if let button = view as? NSButton {
                button.performClick(nil)
            } else if view.responds(to: #selector(NSControl.performClick(_:))) {
                view.perform(#selector(NSControl.performClick(_:)), with: nil)
            }
            for child in view.subviews {
                pressAll(in: child)
            }
        }
    }

    @available(macOS 13.0, *)
    private final class ScenePhaseBox: ObservableObject {
        @Published var phase: ScenePhase = .inactive
    }

    @available(macOS 13.0, *)
    private struct ScenePhaseHost: View {
        @ObservedObject var box: ScenePhaseBox
        var body: some View {
            Text("scene")
                .optelAutoInstrument(appID: "com.example.live", rate: "on", globalHooks: false)
                .environment(\.scenePhase, box.phase)
        }
    }
#endif
