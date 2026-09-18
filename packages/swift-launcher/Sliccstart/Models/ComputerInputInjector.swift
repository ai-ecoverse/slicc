import CoreGraphics
import Foundation
import SliccTrayFollower



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
}


struct LiveCGEventSink: ComputerEventSink {
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

enum ComputerInputDelay {
    static func sleep(_ milliseconds: Double) async {
        guard milliseconds > 0 else { return }
        let ns = UInt64((milliseconds * 1_000_000).rounded())
        try? await Task.sleep(nanoseconds: ns)
    }
}



enum ComputerInputScaler {
    static func nativePoint(
        x: Double, y: Double, encoded: CGSize, native: CGSize
    ) -> CGPoint {
        let sx = encoded.width > 0 ? native.width / encoded.width : 1
        let sy = encoded.height > 0 ? native.height / encoded.height : 1
        return CGPoint(x: x * sx, y: y * sy)
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
    var nativeSize: CGSize
    var delay: (Double) async -> Void
    private var cursor = CGPoint.zero

    init(
        sink: ComputerEventSink, encodedSize: CGSize, nativeSize: CGSize,
        delay: @escaping (Double) async -> Void = ComputerInputDelay.sleep
    ) {
        self.sink = sink
        self.encodedSize = encodedSize
        self.nativeSize = nativeSize
        self.delay = delay
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
                cursor.x += x
                cursor.y += y
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
            sink.post(.scroll(dx: Int32(dx.rounded()), dy: Int32(dy.rounded()), at: cursor))
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
        ComputerInputScaler.nativePoint(x: x, y: y, encoded: encodedSize, native: nativeSize)
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
