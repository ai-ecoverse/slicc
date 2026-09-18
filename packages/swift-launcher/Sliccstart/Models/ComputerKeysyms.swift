import CoreGraphics
import Foundation


struct ComputerKeyPress: Equatable {
    var keyCode: CGKeyCode?
    var unicode: String?
    var shift: Bool
    var ctrl: Bool
    var alt: Bool
    var meta: Bool
}

enum ComputerKeysyms {
    
    static func parse(_ keysym: String) -> ComputerKeyPress? {
        let rawTokens = keysym.split(whereSeparator: { $0 == "+" || $0 == "-" }).map {
            $0.trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
        guard let rawLast = rawTokens.last else { return nil }

        var shift = false
        var ctrl = false
        var alt = false
        var meta = false
        for token in rawTokens.dropLast() {
            switch token.lowercased() {
            case "shift": shift = true
            case "ctrl", "control": ctrl = true
            case "alt", "option": alt = true
            case "meta", "super", "win", "cmd", "command": meta = true
            default: return nil
            }
        }

        let last = rawLast.lowercased()
        if let named = namedCodes[last] {
            return ComputerKeyPress(
                keyCode: named, unicode: nil, shift: shift, ctrl: ctrl, alt: alt, meta: meta)
        }
        if last.count == 1, let scalar = last.unicodeScalars.first {
            let ch = Character(scalar)
            if let code = letterCodes[ch] {
                return ComputerKeyPress(
                    keyCode: code, unicode: nil, shift: shift, ctrl: ctrl, alt: alt, meta: meta)
            }
            if let code = digitCodes[ch] {
                return ComputerKeyPress(
                    keyCode: code, unicode: nil, shift: shift, ctrl: ctrl, alt: alt, meta: meta)
            }
            return ComputerKeyPress(
                keyCode: nil, unicode: last, shift: shift, ctrl: ctrl, alt: alt, meta: meta)
        }
        return nil
    }

    
    private static let namedCodes: [String: CGKeyCode] = [
        "return": 0x24, "enter": 0x24, "kp_enter": 0x4C,
        "tab": 0x30, "space": 0x31,
        "backspace": 0x33, "delete": 0x75, "del": 0x75,
        "escape": 0x35, "esc": 0x35,
        "command": 0x37, "shift": 0x38, "capslock": 0x39, "caps_lock": 0x39,
        "option": 0x3A, "alt": 0x3A, "control": 0x3B, "ctrl": 0x3B,
        "home": 0x73, "end": 0x77, "pageup": 0x74, "page_up": 0x74, "prior": 0x74,
        "pagedown": 0x79, "page_down": 0x79, "next": 0x79,
        "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
        "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60,
        "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D,
        "f11": 0x67, "f12": 0x6F, "f13": 0x69, "f14": 0x6B, "f15": 0x71,
        "f16": 0x6A, "f17": 0x40, "f18": 0x4F, "f19": 0x50, "f20": 0x5A,
        "grave": 0x32, "minus": 0x1B, "equal": 0x18,
        "leftbracket": 0x21, "rightbracket": 0x1E, "backslash": 0x2A,
        "semicolon": 0x29, "quote": 0x27, "comma": 0x2B, "period": 0x2F, "slash": 0x2C,
    ]

    private static let letterCodes: [Character: CGKeyCode] = [
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
        "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B,
        "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11,
        "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
        "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D,
        "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23,
        "l": 0x25, "j": 0x26, "k": 0x28,
        "n": 0x2D, "m": 0x2E,
    ]

    private static let digitCodes: [Character: CGKeyCode] = [
        "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "5": 0x17,
        "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19, "0": 0x1D,
    ]
}
