import CoreGraphics
import Foundation
import SliccTrayFollower

/// One CGEvent the injector would post. Tests record these; the live sink
/// turns them into `CGEvent.post`.
enum ComputerCGAction: Equatable {
    case mouseMove(CGPoint)
    case mouseButton(CGMouseButton, down: Bool, at: CGPoint)
    case scroll(dx: Int32, dy: Int32, at: CGPoint)
    case key(CGKeyCode, down: Bool, flags: CGEventFlags)
    case unicode(String, flags: CGEventFlags)
    case wait(milliseconds: Double)
}

protocol ComputerEventSink {
    func post(_ action: ComputerCGAction)
    /// The pointer's current global `CGEvent` point, or nil when unknown.
    func cursorLocation() -> CGPoint?
}

extension ComputerEventSink {
    func cursorLocation() -> CGPoint? { nil }
}

/// Posts into the real event tap. Unused in unit tests.
struct LiveCGEventSink: ComputerEventSink {
    func cursorLocation() -> CGPoint? {
        CGEvent(source: nil)?.location
    }

    func post(_ action: ComputerCGAction) {
        switch action {
        case .mouseMove(let point):
            let event = CGEvent(
                mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point,
                mouseButton: .left)
            event?.post(tap: .cghidEventTap)
        case .mouseButton(let button, let down, let point):
            let type: CGEventType
            switch (button, down) {
            case (.left, true): type = .leftMouseDown
            case (.left, false): type = .leftMouseUp
            case (.right, true): type = .rightMouseDown
            case (.right, false): type = .rightMouseUp
            default: type = down ? .otherMouseDown : .otherMouseUp
            }
            let event = CGEvent(
                mouseEventSource: nil, mouseType: type, mouseCursorPosition: point,
                mouseButton: button)
            event?.post(tap: .cghidEventTap)
        case .scroll(let dx, let dy, let at):
            let event = CGEvent(
                scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx,
                wheel3: 0)
            event?.location = at
            event?.post(tap: .cghidEventTap)
        case .key(let code, let down, let flags):
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        case .unicode(let text, let flags):
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            var scalars = Array(text.utf16)
            event?.keyboardSetUnicodeString(stringLength: scalars.count, unicodeString: &scalars)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            up?.flags = flags
            up?.post(tap: .cghidEventTap)
        case .wait:
            break
        }
    }
}

/// Wire numbers arrive as `Double`, and `Int(_:)` / `Int32(_:)` / `UInt64(_:)`
/// trap on anything they cannot represent. A peer must never be able to crash
/// the follower with a large number, so every wire → integer conversion goes
/// through here.
enum ComputerWireNumber {
    /// The nearest `Int`, or nil for NaN, infinity, or a value outside `Int`.
    static func int(_ value: Double) -> Int? {
        Int(exactly: value.rounded())
    }

    static func int32(_ value: Double) -> Int32 {
        guard value.isFinite else { return 0 }
        return Int32(max(Double(Int32.min), min(Double(Int32.max), value.rounded())))
    }

    /// Non-negative nanoseconds, saturating well below `UInt64.max` (whose
    /// `Double` rounds up past it and would itself trap).
    static func nanoseconds(milliseconds: Double) -> UInt64 {
        guard milliseconds.isFinite, milliseconds > 0 else { return 0 }
        return UInt64(min(milliseconds * 1_000_000, 9e18).rounded())
    }
}

enum ComputerInputDelay {
    static func sleep(_ milliseconds: Double) async {
        let ns = ComputerWireNumber.nanoseconds(milliseconds: milliseconds)
        guard ns > 0 else { return }
        try? await Task.sleep(nanoseconds: ns)
    }
}

/// Screenshot-space events → the global point space `CGEvent` posts into.
///
/// Two steps, both load-bearing: scale into the captured display's native
/// pixels, then divide by its backing scale and add its origin. `CGEvent`'s
/// origin is the *main* display's top-left, and the captured display need not be
/// the main one — on a four-display Mac Studio it is not (#3379/#3385).
enum ComputerInputScaler {
    /// Screenshot space → the captured display's own native pixels.
    static func nativePoint(
        x: Double, y: Double, encoded: CGSize, native: CGSize
    ) -> CGPoint {
        let sx = encoded.width > 0 ? native.width / encoded.width : 1
        let sy = encoded.height > 0 ? native.height / encoded.height : 1
        return CGPoint(x: x * sx, y: y * sy)
    }

    /// Screenshot space → global `CGEvent` points on the display the frame came from.
    static func globalPoint(
        x: Double, y: Double, encoded: CGSize, display: ComputerDisplayGeometry
    ) -> CGPoint {
        display.globalPoint(
            fromPixel: nativePoint(x: x, y: y, encoded: encoded, native: display.pixelSize))
    }

    /// A screenshot-space *delta* → global points: the same scale as
    /// ``globalPoint`` but no origin, since a delta has no position.
    static func globalDelta(
        dx: Double, dy: Double, encoded: CGSize, display: ComputerDisplayGeometry
    ) -> CGPoint {
        display.globalDelta(
            fromPixel: nativePoint(x: dx, y: dy, encoded: encoded, native: display.pixelSize))
    }
}

enum ComputerInputError: Error, Equatable, CustomStringConvertible {
    case unknownKeysym(String)

    var message: String {
        switch self {
        case .unknownKeysym(let keysym):
            return "unknown keysym '\(keysym)' for macOS"
        }
    }

    var description: String { message }
}

struct ComputerInputInjector {
    var sink: ComputerEventSink
    var encodedSize: CGSize
    var display: ComputerDisplayGeometry
    var delay: (Double) async -> Void
    /// Nil until an event positions the pointer; a relative move or a
    /// coordinate-less button before that starts from where the pointer really is.
    private var knownCursor: CGPoint?

    private var cursor: CGPoint {
        get { knownCursor ?? sink.cursorLocation() ?? display.origin }
        set { knownCursor = newValue }
    }

    init(
        sink: ComputerEventSink, encodedSize: CGSize, display: ComputerDisplayGeometry,
        delay: @escaping (Double) async -> Void = ComputerInputDelay.sleep
    ) {
        self.sink = sink
        self.encodedSize = encodedSize
        self.display = display
        self.delay = delay
    }

    /// Size-only caller: zero origin and scale 1, so screenshot space maps
    /// straight onto the main display as it did before display selection landed.
    init(
        sink: ComputerEventSink, encodedSize: CGSize, nativeSize: CGSize,
        delay: @escaping (Double) async -> Void = ComputerInputDelay.sleep
    ) {
        self.init(
            sink: sink, encodedSize: encodedSize,
            display: .identity(size: nativeSize), delay: delay)
    }

    mutating func apply(_ events: [ComputerInputEvent]) async throws {
        try Self.validate(events)
        for event in events {
            await perform(event)
        }
    }

    static func validate(_ events: [ComputerInputEvent]) throws {
        for event in events {
            if case .key(let keysym, _) = event {
                guard ComputerKeysyms.parse(keysym) != nil else {
                    throw ComputerInputError.unknownKeysym(keysym)
                }
            }
        }
    }

    private mutating func perform(_ event: ComputerInputEvent) async {
        switch event {
        case .mousemove(let x, let y, let relative):
            if relative == true {
                let delta = ComputerInputScaler.globalDelta(
                    dx: x, dy: y, encoded: encodedSize, display: display)
                let from = cursor
                cursor = CGPoint(x: from.x + delta.x, y: from.y + delta.y)
            } else {
                cursor = point(x, y)
            }
            sink.post(.mouseMove(cursor))
        case .button(let button, let down, let x, let y):
            if let x, let y { cursor = point(x, y) }
            sink.post(.mouseButton(cgButton(button), down: down, at: cursor))
        case .click(let button, let count, let holdMs, let x, let y):
            if let x, let y { cursor = point(x, y) }
            let cg = cgButton(button)
            let hold = holdMs ?? 0
            for _ in 0..<max(1, count) {
                sink.post(.mouseButton(cg, down: true, at: cursor))
                if hold > 0 {
                    sink.post(.wait(milliseconds: hold))
                    await delay(hold)
                }
                sink.post(.mouseButton(cg, down: false, at: cursor))
            }
        case .scroll(let dx, let dy, let x, let y):
            if let x, let y { cursor = point(x, y) }
            sink.post(
                .scroll(
                    dx: ComputerWireNumber.int32(dx), dy: ComputerWireNumber.int32(dy),
                    at: cursor))
        case .drag(let x1, let y1, let x2, let y2):
            cursor = point(x1, y1)
            sink.post(.mouseMove(cursor))
            sink.post(.mouseButton(.left, down: true, at: cursor))
            cursor = point(x2, y2)
            sink.post(.mouseMove(cursor))
            sink.post(.mouseButton(.left, down: false, at: cursor))
        case .key(let keysym, let down):
            guard let press = ComputerKeysyms.parse(keysym) else { return }
            let flags = flags(of: press)
            let keyDown = down ?? true
            if let code = press.keyCode {
                if down == nil {
                    sink.post(.key(code, down: true, flags: flags))
                    sink.post(.key(code, down: false, flags: flags))
                } else {
                    sink.post(.key(code, down: keyDown, flags: flags))
                }
            } else if let unicode = press.unicode {
                sink.post(.unicode(unicode, flags: flags))
            }
        case .text(let text):
            sink.post(.unicode(text, flags: []))
        case .wait(let ms):
            sink.post(.wait(milliseconds: ms))
            await delay(ms)
        }
    }

    private func point(_ x: Double, _ y: Double) -> CGPoint {
        ComputerInputScaler.globalPoint(x: x, y: y, encoded: encodedSize, display: display)
    }

    private func cgButton(_ button: Int) -> CGMouseButton {
        if button == 2 { return .center }
        if button == 3 { return .right }
        return .left
    }

    private func flags(of press: ComputerKeyPress) -> CGEventFlags {
        var flags: CGEventFlags = []
        if press.shift { flags.insert(.maskShift) }
        if press.ctrl { flags.insert(.maskControl) }
        if press.alt { flags.insert(.maskAlternate) }
        if press.meta { flags.insert(.maskCommand) }
        return flags
    }
}
