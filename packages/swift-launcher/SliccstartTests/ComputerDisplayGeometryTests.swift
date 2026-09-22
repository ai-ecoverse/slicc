import CoreGraphics
import XCTest

@testable import Sliccstart




enum ComputerDisplayFixtures {
    static let main = ComputerDisplayGeometry(
        displayID: 2,
        origin: CGPoint(x: 0, y: 0),
        pointSize: CGSize(width: 2560, height: 1440),
        pixelSize: CGSize(width: 5120, height: 2880),
        isMain: true)
    static let below = ComputerDisplayGeometry(
        displayID: 1,
        origin: CGPoint(x: 0, y: 1443),
        pointSize: CGSize(width: 2560, height: 1440),
        pixelSize: CGSize(width: 5120, height: 2880))
    static let right = ComputerDisplayGeometry(
        displayID: 3,
        origin: CGPoint(x: 2560, y: 323),
        pointSize: CGSize(width: 1440, height: 2560),
        pixelSize: CGSize(width: 2880, height: 5120))
    static let left = ComputerDisplayGeometry(
        displayID: 4,
        origin: CGPoint(x: -1440, y: 280),
        pointSize: CGSize(width: 1440, height: 2560),
        pixelSize: CGSize(width: 2880, height: 5120))

    
    static let shareableOrder = [right, main, below, left]
    
    static let activeOrder: [CGDirectDisplayID] = [2, 1, 3, 4]
}

final class ComputerDisplayGeometryTests: XCTestCase {
    func testPointsAndPixelsAreKeptApart() {
        let display = ComputerDisplayFixtures.right
        XCTAssertEqual(display.pointSize, CGSize(width: 1440, height: 2560))
        XCTAssertEqual(display.pixelSize, CGSize(width: 2880, height: 5120))
        XCTAssertEqual(display.scale, CGSize(width: 2, height: 2))
    }

    func testMissingPixelSizeFallsBackToPointsAtScaleOne() {
        let display = ComputerDisplayGeometry(
            displayID: 9, origin: .zero, pointSize: CGSize(width: 1280, height: 800),
            pixelSize: .zero)
        XCTAssertEqual(display.pixelSize, CGSize(width: 1280, height: 800))
        XCTAssertEqual(display.scale, CGSize(width: 1, height: 1))
    }

    func testGlobalPointDividesByScaleAndAddsOrigin() {
        
        
        let centre = ComputerDisplayFixtures.right.globalPoint(
            fromPixel: CGPoint(x: 1440, y: 2560))
        XCTAssertEqual(centre, CGPoint(x: 2560 + 720, y: 323 + 1280))
    }

    func testGlobalPointGoesNegativeForADisplayLeftOfMain() {
        let topLeft = ComputerDisplayFixtures.left.globalPoint(fromPixel: .zero)
        XCTAssertEqual(topLeft, CGPoint(x: -1440, y: 280))
        let centre = ComputerDisplayFixtures.left.globalPoint(fromPixel: CGPoint(x: 1440, y: 2560))
        XCTAssertEqual(centre, CGPoint(x: -720, y: 1560))
    }

    func testIdentityGeometryReproducesPreSelectionBehaviour() {
        let identity = ComputerDisplayGeometry.identity(size: CGSize(width: 1920, height: 1080))
        XCTAssertEqual(identity.scale, CGSize(width: 1, height: 1))
        XCTAssertEqual(
            identity.globalPoint(fromPixel: CGPoint(x: 100, y: 50)), CGPoint(x: 100, y: 50))
    }

    func testDefaultIsTheMainDisplayNotWhateverScreenCaptureKitListsFirst() throws {
        let picked = try ComputerDisplaySelection.pick(
            from: ComputerDisplayFixtures.shareableOrder,
            activeOrder: ComputerDisplayFixtures.activeOrder,
            index: nil)
        XCTAssertEqual(picked.displayID, 2)
        XCTAssertNotEqual(picked.displayID, ComputerDisplayFixtures.shareableOrder[0].displayID)
    }

    func testIndexFollowsTheOSDisplayOrder() throws {
        let ids = try (1...4).map {
            try ComputerDisplaySelection.pick(
                from: ComputerDisplayFixtures.shareableOrder,
                activeOrder: ComputerDisplayFixtures.activeOrder,
                index: $0
            ).displayID
        }
        XCTAssertEqual(ids, [2, 1, 3, 4])
    }

    func testEveryAttachedDisplayIsReachable() throws {
        for (offset, expected) in ComputerDisplaySelection.ordered(
            ComputerDisplayFixtures.shareableOrder,
            activeOrder: ComputerDisplayFixtures.activeOrder
        ).enumerated() {
            let picked = try ComputerDisplaySelection.pick(
                from: ComputerDisplayFixtures.shareableOrder,
                activeOrder: ComputerDisplayFixtures.activeOrder,
                index: offset + 1)
            XCTAssertEqual(picked, expected)
        }
    }

    func testDisplaysMissingFromTheActiveListSortLastInDiscoveryOrder() {
        let unknown = ComputerDisplayGeometry(
            displayID: 77, origin: .zero, pointSize: CGSize(width: 100, height: 100))
        let ordered = ComputerDisplaySelection.ordered(
            [unknown] + ComputerDisplayFixtures.shareableOrder,
            activeOrder: ComputerDisplayFixtures.activeOrder)
        XCTAssertEqual(ordered.map(\.displayID), [2, 1, 3, 4, 77])
    }

    func testOutOfRangeIndexNamesTheAttachedDisplays() {
        do {
            _ = try ComputerDisplaySelection.pick(
                from: ComputerDisplayFixtures.shareableOrder,
                activeOrder: ComputerDisplayFixtures.activeOrder,
                index: 7)
            XCTFail("expected a displayOutOfRange failure")
        } catch let error as ComputerCaptureError {
            XCTAssertEqual(
                error,
                .displayOutOfRange(
                    index: 7,
                    available: "1=5120x2880 (main), 2=5120x2880, 3=2880x5120, 4=2880x5120"))
            XCTAssertTrue(error.message.contains("display 7 is not attached"))
            XCTAssertTrue(error.message.contains("1=5120x2880 (main)"))
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testZeroAndNegativeIndicesAreRejectedRatherThanWrappingAround() {
        for index in [0, -1] {
            XCTAssertThrowsError(
                try ComputerDisplaySelection.pick(
                    from: ComputerDisplayFixtures.shareableOrder,
                    activeOrder: ComputerDisplayFixtures.activeOrder,
                    index: index))
        }
    }

    func testNoDisplaysIsNoDisplayNotAnIndexError() {
        XCTAssertThrowsError(
            try ComputerDisplaySelection.pick(from: [], activeOrder: [], index: nil)
        ) { error in
            XCTAssertEqual(error as? ComputerCaptureError, .noDisplay)
        }
    }

    func testEmptyActiveListStillPicksTheMainDisplay() throws {
        let picked = try ComputerDisplaySelection.pick(
            from: ComputerDisplayFixtures.shareableOrder, activeOrder: [], index: nil)
        XCTAssertEqual(picked.displayID, 2)
    }

    func testNoMainFlagFallsBackToTheFirstOrderedDisplay() throws {
        let headless = ComputerDisplayFixtures.shareableOrder.map {
            ComputerDisplayGeometry(
                displayID: $0.displayID, origin: $0.origin, pointSize: $0.pointSize,
                pixelSize: $0.pixelSize, isMain: false)
        }
        let picked = try ComputerDisplaySelection.pick(
            from: headless, activeOrder: ComputerDisplayFixtures.activeOrder, index: nil)
        XCTAssertEqual(picked.displayID, 2)
    }

    func testStreamConfigurationUsesPixelsSoASizeCapCanExceedThePointWidth() {
        let display = ComputerDisplayFixtures.right
        let uncapped = ComputerCaptureLayout.outputSize(
            nativeWidth: Int(display.pixelSize.width),
            nativeHeight: Int(display.pixelSize.height),
            maxWidth: nil)
        XCTAssertEqual(uncapped.width, 2880)
        XCTAssertEqual(uncapped.height, 5120)
        
        let capped = ComputerCaptureLayout.outputSize(
            nativeWidth: Int(display.pixelSize.width),
            nativeHeight: Int(display.pixelSize.height),
            maxWidth: 1536)
        XCTAssertEqual(capped.width, 1536)
        XCTAssertEqual(capped.height, 2731)
    }
}

final class ComputerInputOriginTests: XCTestCase {
    func testGlobalPointTranslatesScreenshotSpaceOntoTheCapturedDisplay() {
        
        
        let display = ComputerDisplayFixtures.right
        let point = ComputerInputScaler.globalPoint(
            x: 384, y: 683, encoded: CGSize(width: 768, height: 1366), display: display)
        XCTAssertEqual(point.x, 2560 + 720, accuracy: 0.5)
        XCTAssertEqual(point.y, 323 + 1280, accuracy: 1)
    }

    func testNativePixelsStayInPixelsBeforeTheOriginIsApplied() {
        let display = ComputerDisplayFixtures.right
        let pixel = ComputerInputScaler.nativePoint(
            x: 384, y: 683, encoded: CGSize(width: 768, height: 1366),
            native: display.pixelSize)
        XCTAssertEqual(pixel.x, 1440, accuracy: 0.5)
        XCTAssertEqual(pixel.y, 2560, accuracy: 2)
    }

    func testInjectorPostsGlobalPointsForANonMainDisplay() async throws {
        let sink = RecordingEventSink()
        let display = ComputerDisplayFixtures.right
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: display.pixelSize, display: display, delay: { _ in })
        try await injector.apply([
            .click(button: 1, count: 1, holdMs: nil, x: 1440, y: 2560)
        ])
        let expected = CGPoint(x: 3280, y: 1603)
        XCTAssertEqual(
            sink.actions,
            [
                .mouseButton(.left, down: true, at: expected),
                .mouseButton(.left, down: false, at: expected),
            ])
    }

    func testInjectorOnTheMainDisplayOnlyUndoesTheBackingScale() async throws {
        let sink = RecordingEventSink()
        let display = ComputerDisplayFixtures.main
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: display.pixelSize, display: display, delay: { _ in })
        try await injector.apply([.mousemove(x: 5120, y: 2880, relative: false)])
        XCTAssertEqual(sink.actions, [.mouseMove(CGPoint(x: 2560, y: 1440))])
    }

    func testInjectorOnADisplayLeftOfMainPostsNegativeCoordinates() async throws {
        let sink = RecordingEventSink()
        let display = ComputerDisplayFixtures.left
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: display.pixelSize, display: display, delay: { _ in })
        try await injector.apply([.mousemove(x: 0, y: 0, relative: false)])
        XCTAssertEqual(sink.actions, [.mouseMove(CGPoint(x: -1440, y: 280))])
    }

    
    
    func testRelativeMoveOnARetinaDisplayScalesTheDeltaButAddsNoOrigin() async throws {
        let sink = RecordingEventSink()
        let display = ComputerDisplayFixtures.right
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: display.pixelSize, display: display, delay: { _ in })
        try await injector.apply([
            .mousemove(x: 0, y: 0, relative: false),
            .mousemove(x: 200, y: -100, relative: true),
        ])
        XCTAssertEqual(
            sink.actions,
            [
                .mouseMove(CGPoint(x: 2560, y: 323)),
                .mouseMove(CGPoint(x: 2660, y: 273)),
            ])
    }

    func testRelativeMoveBeforeAnyAbsoluteStartsFromTheRealPointer() async throws {
        let sink = RecordingEventSink()
        sink.cursor = CGPoint(x: 100, y: 50)
        let display = ComputerDisplayFixtures.main
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: display.pixelSize, display: display, delay: { _ in })
        try await injector.apply([.mousemove(x: 20, y: 20, relative: true)])
        XCTAssertEqual(sink.actions, [.mouseMove(CGPoint(x: 110, y: 60))])
    }

    func testRelativeMoveWithNoKnownPointerStartsAtTheDisplayOrigin() async throws {
        let sink = RecordingEventSink()
        let display = ComputerDisplayFixtures.left
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: display.pixelSize, display: display, delay: { _ in })
        try await injector.apply([.mousemove(x: 2, y: 2, relative: true)])
        XCTAssertEqual(sink.actions, [.mouseMove(CGPoint(x: -1439, y: 281))])
    }

    func testGlobalDeltaUndoesScaleOnly() {
        XCTAssertEqual(
            ComputerDisplayFixtures.left.globalDelta(fromPixel: CGPoint(x: 10, y: -4)),
            CGPoint(x: 5, y: -2))
    }
}

final class ComputerWireNumberTests: XCTestCase {
    
    func testIntRejectsWhatIntCannotHold() {
        XCTAssertNil(ComputerWireNumber.int(1e19))
        XCTAssertNil(ComputerWireNumber.int(-1e19))
        XCTAssertNil(ComputerWireNumber.int(.nan))
        XCTAssertNil(ComputerWireNumber.int(.infinity))
        XCTAssertEqual(ComputerWireNumber.int(2.6), 3)
    }

    func testInt32Saturates() {
        XCTAssertEqual(ComputerWireNumber.int32(1e19), Int32.max)
        XCTAssertEqual(ComputerWireNumber.int32(-1e19), Int32.min)
        XCTAssertEqual(ComputerWireNumber.int32(.nan), 0)
        XCTAssertEqual(ComputerWireNumber.int32(-2.4), -2)
    }

    func testNanosecondsSaturatesAndFloorsAtZero() {
        XCTAssertEqual(ComputerWireNumber.nanoseconds(milliseconds: 1e300), 9_000_000_000_000_000_000)
        XCTAssertEqual(ComputerWireNumber.nanoseconds(milliseconds: -5), 0)
        XCTAssertEqual(ComputerWireNumber.nanoseconds(milliseconds: 2), 2_000_000)
    }

    func testAHugeScrollDoesNotTrapTheInjector() async throws {
        let sink = RecordingEventSink()
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: CGSize(width: 10, height: 10),
            nativeSize: CGSize(width: 10, height: 10), delay: { _ in })
        try await injector.apply([.scroll(dx: 1e19, dy: -1e19, x: 1, y: 1)])
        XCTAssertEqual(
            sink.actions, [.scroll(dx: Int32.max, dy: Int32.min, at: CGPoint(x: 1, y: 1))])
    }
}


private final class PostOnlySink: ComputerEventSink {
    private(set) var actions: [ComputerCGAction] = []
    func post(_ action: ComputerCGAction) { actions.append(action) }
}

final class ComputerEventSinkTests: XCTestCase {
    
    
    func testASinkWithoutAPointerReadingStartsRelativeMovesAtTheDisplayOrigin() async throws {
        let sink = PostOnlySink()
        XCTAssertNil(sink.cursorLocation())
        let display = ComputerDisplayFixtures.right
        var injector = ComputerInputInjector(
            sink: sink, encodedSize: display.pixelSize, display: display, delay: { _ in })
        try await injector.apply([.mousemove(x: 4, y: 4, relative: true)])
        XCTAssertEqual(sink.actions, [.mouseMove(CGPoint(x: 2562, y: 325))])
    }

    
    
    func testTheLiveSinkReadsThePointerAndTreatsWaitAsANoOp() {
        let sink = LiveCGEventSink()
        if let point = sink.cursorLocation() {
            XCTAssertTrue(point.x.isFinite && point.y.isFinite)
        }
        sink.post(.wait(milliseconds: 1))
    }
}




final class ComputerLiveDisplayTests: XCTestCase {
    func testLiveDefaultIsTheMainDisplayInItsPixels() throws {
        let geometry: ComputerDisplayGeometry
        do {
            geometry = try ScreenCaptureKitCapturer.liveGeometry(index: nil)
        } catch ComputerCaptureError.noDisplay {
            throw XCTSkip("test host has no active display")
        }
        XCTAssertEqual(geometry.displayID, CGMainDisplayID())
        XCTAssertTrue(geometry.isMain)
        XCTAssertEqual(geometry.origin, .zero, "the main display anchors the global space")
        XCTAssertGreaterThan(geometry.pointSize.width, 0)
        XCTAssertGreaterThanOrEqual(geometry.pixelSize.width, geometry.pointSize.width)
        XCTAssertGreaterThanOrEqual(geometry.pixelSize.height, geometry.pointSize.height)
    }

    func testLiveIndexOneIsTheFirstActiveDisplay() throws {
        do {
            let first = try ScreenCaptureKitCapturer.liveGeometry(index: 1)
            XCTAssertNotEqual(first.displayID, 0)
        } catch ComputerCaptureError.noDisplay {
            throw XCTSkip("test host has no active display")
        }
    }

    func testLiveIndexPastTheAttachedDisplaysIsAnErrorNotATrap() {
        XCTAssertThrowsError(try ScreenCaptureKitCapturer.liveGeometry(index: 99)) { error in
            switch error as? ComputerCaptureError {
            case .displayOutOfRange(let index, let available):
                XCTAssertEqual(index, 99)
                XCTAssertTrue(available.hasPrefix("1="), available)
            case .noDisplay:
                break
            default:
                XCTFail("unexpected \(error)")
            }
        }
    }

    @MainActor
    func testStoppingACapturerThatNeverStartedIsANoOp() {
        let capturer = ScreenCaptureKitCapturer()
        capturer.stop()
        capturer.stop()
    }
}
