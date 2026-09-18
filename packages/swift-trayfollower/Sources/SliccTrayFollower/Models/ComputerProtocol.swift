import Foundation

// MARK: - Computer protocol (mirrors packages/shared-ts/src/computer-protocol.ts)

/// Pixel size of a computer screen or last shot.
public struct ComputerSize: Codable, Equatable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

/// What a computer backend can do. `inputAllowed` is the sudo/`--allow-input` gate.
public struct ComputerCapabilities: Codable, Equatable {
    public let screenshot: Bool
    public let text: Bool
    public let frames: String
    public let keyboard: Bool
    public let mouse: String
    public let scroll: Bool
    public let exec: Bool
    public let inputAllowed: Bool

    public init(
        screenshot: Bool,
        text: Bool,
        frames: String,
        keyboard: Bool,
        mouse: String,
        scroll: Bool,
        exec: Bool,
        inputAllowed: Bool
    ) {
        self.screenshot = screenshot
        self.text = text
        self.frames = frames
        self.keyboard = keyboard
        self.mouse = mouse
        self.scroll = scroll
        self.exec = exec
        self.inputAllowed = inputAllowed
    }
}

/// On-screen soft key (adb Home/Back, Simulator Home).
public struct ComputerSoftKey: Codable, Equatable {
    public let label: String
    public let keysym: String

    public init(label: String, keysym: String) {
        self.label = label
        self.keysym = keysym
    }
}

/// Screenshot-space size of the last frame the model saw.
public struct ComputerLastShot: Codable, Equatable {
    public let width: Double
    public let height: Double
    public let scale: Double
    public let at: Double

    public init(width: Double, height: Double, scale: Double, at: Double) {
        self.width = width
        self.height = height
        self.scale = scale
        self.at = at
    }
}

/// Roster row for a registered computer.
public struct ComputerDescriptor: Codable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let title: String
    public let size: ComputerSize?
    public let state: String
    public let capabilities: ComputerCapabilities
    public let pid: Int?
    public let softKeys: [ComputerSoftKey]?
    public let lastShot: ComputerLastShot?

    public init(
        id: String,
        kind: String,
        title: String,
        size: ComputerSize?,
        state: String,
        capabilities: ComputerCapabilities,
        pid: Int?,
        softKeys: [ComputerSoftKey]? = nil,
        lastShot: ComputerLastShot? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.size = size
        self.state = state
        self.capabilities = capabilities
        self.pid = pid
        self.softKeys = softKeys
        self.lastShot = lastShot
    }
}

/// xdotool-shaped input event. Coordinates are screenshot-space unless noted.
public enum ComputerInputEvent: Codable, Equatable {
    case mousemove(x: Double, y: Double, relative: Bool?)
    case button(button: Int, down: Bool, x: Double?, y: Double?)
    case click(button: Int, count: Int, holdMs: Double?, x: Double?, y: Double?)
    case scroll(dx: Double, dy: Double, x: Double?, y: Double?)
    case drag(x1: Double, y1: Double, x2: Double, y2: Double)
    case key(keysym: String, down: Bool?)
    case text(text: String)
    case wait(ms: Double)

    private enum CodingKeys: String, CodingKey {
        case type, x, y, relative, button, down, count, holdMs, dx, dy, x1, y1, x2, y2, keysym, text, ms
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "mousemove":
            self = .mousemove(
                x: try container.decode(Double.self, forKey: .x),
                y: try container.decode(Double.self, forKey: .y),
                relative: try container.decodeIfPresent(Bool.self, forKey: .relative))
        case "button":
            self = .button(
                button: try container.decode(Int.self, forKey: .button),
                down: try container.decode(Bool.self, forKey: .down),
                x: try container.decodeIfPresent(Double.self, forKey: .x),
                y: try container.decodeIfPresent(Double.self, forKey: .y))
        case "click":
            self = .click(
                button: try container.decode(Int.self, forKey: .button),
                count: try container.decode(Int.self, forKey: .count),
                holdMs: try container.decodeIfPresent(Double.self, forKey: .holdMs),
                x: try container.decodeIfPresent(Double.self, forKey: .x),
                y: try container.decodeIfPresent(Double.self, forKey: .y))
        case "scroll":
            self = .scroll(
                dx: try container.decode(Double.self, forKey: .dx),
                dy: try container.decode(Double.self, forKey: .dy),
                x: try container.decodeIfPresent(Double.self, forKey: .x),
                y: try container.decodeIfPresent(Double.self, forKey: .y))
        case "drag":
            self = .drag(
                x1: try container.decode(Double.self, forKey: .x1),
                y1: try container.decode(Double.self, forKey: .y1),
                x2: try container.decode(Double.self, forKey: .x2),
                y2: try container.decode(Double.self, forKey: .y2))
        case "key":
            self = .key(
                keysym: try container.decode(String.self, forKey: .keysym),
                down: try container.decodeIfPresent(Bool.self, forKey: .down))
        case "text":
            self = .text(text: try container.decode(String.self, forKey: .text))
        case "wait":
            self = .wait(ms: try container.decode(Double.self, forKey: .ms))
        default:
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unknown ComputerInputEvent type: \(type)"))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .mousemove(let x, let y, let relative):
            try container.encode("mousemove", forKey: .type)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            try container.encodeIfPresent(relative, forKey: .relative)
        case .button(let button, let down, let x, let y):
            try container.encode("button", forKey: .type)
            try container.encode(button, forKey: .button)
            try container.encode(down, forKey: .down)
            try container.encodeIfPresent(x, forKey: .x)
            try container.encodeIfPresent(y, forKey: .y)
        case .click(let button, let count, let holdMs, let x, let y):
            try container.encode("click", forKey: .type)
            try container.encode(button, forKey: .button)
            try container.encode(count, forKey: .count)
            try container.encodeIfPresent(holdMs, forKey: .holdMs)
            try container.encodeIfPresent(x, forKey: .x)
            try container.encodeIfPresent(y, forKey: .y)
        case .scroll(let dx, let dy, let x, let y):
            try container.encode("scroll", forKey: .type)
            try container.encode(dx, forKey: .dx)
            try container.encode(dy, forKey: .dy)
            try container.encodeIfPresent(x, forKey: .x)
            try container.encodeIfPresent(y, forKey: .y)
        case .drag(let x1, let y1, let x2, let y2):
            try container.encode("drag", forKey: .type)
            try container.encode(x1, forKey: .x1)
            try container.encode(y1, forKey: .y1)
            try container.encode(x2, forKey: .x2)
            try container.encode(y2, forKey: .y2)
        case .key(let keysym, let down):
            try container.encode("key", forKey: .type)
            try container.encode(keysym, forKey: .keysym)
            try container.encodeIfPresent(down, forKey: .down)
        case .text(let text):
            try container.encode("text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .wait(let ms):
            try container.encode("wait", forKey: .type)
            try container.encode(ms, forKey: .ms)
        }
    }
}
