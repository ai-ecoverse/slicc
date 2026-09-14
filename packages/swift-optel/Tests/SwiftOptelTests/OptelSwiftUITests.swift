#if canImport(SwiftUI)
    import SwiftUI
    import XCTest
    @testable import SwiftOptel

    @available(iOS 16.0, macOS 13.0, *)
    final class OptelSwiftUITests: XCTestCase {
        

        
        
        
        
        func testEnterRefiresOnBackgroundInactiveActiveSequence() {
            var wasBackgrounded = false
            var enterFires = 0

            let phases: [ScenePhase] = [.background, .inactive, .active]
            for phase in phases {
                let next = OptelAutoInstrumentModifier.nextState(
                    forNewPhase: phase,
                    wasBackgrounded: wasBackgrounded
                )
                wasBackgrounded = next.wasBackgrounded
                if next.shouldFireEnter { enterFires += 1 }
            }
            XCTAssertEqual(enterFires, 1)
            XCTAssertFalse(wasBackgrounded, "active transition should clear the flag")
        }

        func testEnterDoesNotFireWithoutPriorBackground() {
            var wasBackgrounded = false
            var enterFires = 0
            
            
            
            for phase in [ScenePhase.inactive, .active] {
                let next = OptelAutoInstrumentModifier.nextState(
                    forNewPhase: phase,
                    wasBackgrounded: wasBackgrounded
                )
                wasBackgrounded = next.wasBackgrounded
                if next.shouldFireEnter { enterFires += 1 }
            }
            XCTAssertEqual(enterFires, 0)
        }

        func testEnterFiresOncePerForegroundCycle() {
            var wasBackgrounded = false
            var enterFires = 0
            
            
            let sequence: [ScenePhase] = [
                .background, .inactive, .active,
                .active,
                .background, .inactive, .active,
            ]
            for phase in sequence {
                let next = OptelAutoInstrumentModifier.nextState(
                    forNewPhase: phase,
                    wasBackgrounded: wasBackgrounded
                )
                wasBackgrounded = next.wasBackgrounded
                if next.shouldFireEnter { enterFires += 1 }
            }
            XCTAssertEqual(enterFires, 2)
        }

        func testBackgroundSetsStickyFlagEvenAfterInactive() {
            
            
            var wasBackgrounded = false
            for phase in [ScenePhase.background, .inactive, .inactive, .inactive] {
                let next = OptelAutoInstrumentModifier.nextState(
                    forNewPhase: phase,
                    wasBackgrounded: wasBackgrounded
                )
                wasBackgrounded = next.wasBackgrounded
                XCTAssertFalse(next.shouldFireEnter)
            }
            XCTAssertTrue(wasBackgrounded)
            let final = OptelAutoInstrumentModifier.nextState(
                forNewPhase: .active,
                wasBackgrounded: wasBackgrounded
            )
            XCTAssertTrue(final.shouldFireEnter)
            XCTAssertFalse(final.wasBackgrounded)
        }

        

        func testPerformInstallWithGlobalHooksInstallsUncaughtExceptionHook() {
            OptelUncaughtExceptionHook._testing_reset()
            XCTAssertFalse(OptelUncaughtExceptionHook.isInstalled)
            OptelAutoInstrumentModifier.performInstall(
                appID: "com.example.app",
                rate: "off",
                globalHooks: true
            )
            XCTAssertTrue(OptelUncaughtExceptionHook.isInstalled)
        }

        func testPerformInstallWithoutGlobalHooksSkipsUncaughtExceptionHook() {
            OptelUncaughtExceptionHook._testing_reset()
            XCTAssertFalse(OptelUncaughtExceptionHook.isInstalled)
            OptelAutoInstrumentModifier.performInstall(
                appID: "com.example.app",
                rate: "off",
                globalHooks: false
            )
            XCTAssertFalse(OptelUncaughtExceptionHook.isInstalled)
        }

        #if os(macOS)
            func testPerformInstallWithGlobalHooksInstallsMacHooks() {
                OptelMacAutoInstrument._testing_reset()
                XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
                OptelAutoInstrumentModifier.performInstall(
                    appID: "com.example.app",
                    rate: "off",
                    globalHooks: true
                )
                XCTAssertTrue(OptelMacAutoInstrument.isInstalled)
                OptelMacAutoInstrument.uninstall()
            }

            func testPerformInstallWithoutGlobalHooksSkipsMacHooks() {
                OptelMacAutoInstrument._testing_reset()
                XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
                OptelAutoInstrumentModifier.performInstall(
                    appID: "com.example.app",
                    rate: "off",
                    globalHooks: false
                )
                XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
            }

            func testPerformInstallIsIdempotentForMacHooks() {
                
                
                
                OptelMacAutoInstrument._testing_reset()
                for _ in 0..<3 {
                    OptelAutoInstrumentModifier.performInstall(
                        appID: "com.example.app",
                        rate: "off",
                        globalHooks: true
                    )
                }
                XCTAssertTrue(OptelMacAutoInstrument.isInstalled)
                XCTAssertTrue(OptelClickMonitor.isInstalled)
                XCTAssertTrue(OptelWindowObserver.isInstalled)
                OptelMacAutoInstrument.uninstall()
                XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
            }

            func testMacAutoInstrumentCoordinatorInstallUninstall() {
                OptelMacAutoInstrument._testing_reset()
                XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
                OptelMacAutoInstrument.installIfNeeded()
                XCTAssertTrue(OptelMacAutoInstrument.isInstalled)
                
                OptelMacAutoInstrument.installIfNeeded()
                XCTAssertTrue(OptelMacAutoInstrument.isInstalled)
                OptelMacAutoInstrument.uninstall()
                XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
                
                OptelMacAutoInstrument.uninstall()
                XCTAssertFalse(OptelMacAutoInstrument.isInstalled)
            }
        #endif

        

        private struct FixedRandomSource: RandomSource {
            let value: Double
            func nextUnitDouble() -> Double { value }
        }

        private func configureRecordingOptel() -> RecordingTransport {
            let transport = RecordingTransport()
            Optel.shared.configure(
                appID: "com.example.app",
                rate: "on",
                collectBaseURL: URL(string: "https://rum.hlx.page/")!,
                transport: transport,
                randomSource: FixedRandomSource(value: 0)
            )
            return transport
        }

        func testOptelTapPerformTapClaimsAndEmits() {
            OptelClickCoordinator._testing_reset()
            let transport = configureRecordingOptel()
            
            let epoch = OptelClickCoordinator.beginMonitorEvent()
            OptelTapModifier.performTap(source: "panel view#detail")
            XCTAssertTrue(OptelClickCoordinator.wasClaimedByRefined(epoch: epoch))
            let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
            XCTAssertEqual(clicks.count, 1)
            XCTAssertEqual(clicks.first?.event.pingData.source, "panel view#detail")
        }

        func testOptelButtonPerformTapClaimsAndEmitsDerivedSource() {
            OptelClickCoordinator._testing_reset()
            let transport = configureRecordingOptel()
            let epoch = OptelClickCoordinator.beginMonitorEvent()
            OptelButton<Text>.performTap(
                identifier: "submit",
                label: "Submit",
                context: "checkout"
            )
            XCTAssertTrue(OptelClickCoordinator.wasClaimedByRefined(epoch: epoch))
            let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
            XCTAssertEqual(clicks.count, 1)
            
            XCTAssertEqual(clicks.first?.event.pingData.source, "checkout button#submit")
        }

        #if os(macOS)
            func testRefinedTapAndMonitorTogetherProduceExactlyOneBeacon() {
                
                
                
                OptelClickCoordinator._testing_reset()
                let transport = configureRecordingOptel()
                let epoch = OptelClickCoordinator.beginMonitorEvent()
                OptelTapModifier.performTap(source: "refined#go")
                
                
                OptelClickMonitor.deferredEmit(epoch: epoch, source: "ax#go", target: "Go")
                let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
                XCTAssertEqual(clicks.count, 1)
                XCTAssertEqual(clicks.first?.event.pingData.source, "refined#go")
            }

            func testRefinedButtonAndMonitorTogetherProduceExactlyOneBeacon() {
                OptelClickCoordinator._testing_reset()
                let transport = configureRecordingOptel()
                let epoch = OptelClickCoordinator.beginMonitorEvent()
                OptelButton<Text>.performTap(identifier: "buy", label: "Buy", context: "cart")
                OptelClickMonitor.deferredEmit(epoch: epoch, source: "ax#buy", target: "Buy")
                let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
                XCTAssertEqual(clicks.count, 1)
                XCTAssertEqual(clicks.first?.event.pingData.source, "cart button#buy")
            }

            func testUnrefinedClickStillEmitsViaMonitor() {
                
                
                OptelClickCoordinator._testing_reset()
                let transport = configureRecordingOptel()
                let epoch = OptelClickCoordinator.beginMonitorEvent()
                
                OptelClickMonitor.deferredEmit(epoch: epoch, source: "ax#bare", target: "Bare")
                let clicks = transport.sent.filter { $0.event.checkpoint.rawValue == "click" }
                XCTAssertEqual(clicks.count, 1)
                XCTAssertEqual(clicks.first?.event.pingData.source, "ax#bare")
            }
        #endif
    }
#endif
