import SliccTrayKit
import SwiftUI




enum SliccIcons {

    

    
    
    
    static func tool(_ toolName: String) -> SliccGlyph {
        switch toolName {
        
        case "read_file": return .system("doc.text")  
        case "write_file": return .system("doc.badge.plus")  
        case "edit", "edit_file": return .system("pencil")  
        
        case "bash": return .system("terminal")  
        case "browser": return .system("globe")  
        case "javascript": return .system("chevron.left.forwardslash.chevron.right")  
        
        case "send_message": return .system("message.fill")  
        case "feed_scoop": return .system("fork.knife")  
        case "scoop_scoop": return .lucide(.iceCreamCone)  
        case "drop_scoop": return .system("trash")  
        case "scoop_mute": return .system("bell.slash")  
        case "scoop_unmute": return .system("bell.and.waves.left.and.right")  
        case "scoop_wait": return .system("hourglass")  
        case "list_scoops": return .lucide(.iceCreamCone)  
        case "list_tasks": return .system("checklist")  
        case "register_scoop": return .system("person.badge.plus")  
        case "schedule_task": return .system("clock")  
        case "update_global_memory": return .system("brain")  
        case "delegate_to_scoop": return .system("paperplane.fill")  
        default: return .system("wrench.and.screwdriver")
        }
    }

    
    static func toolTitle(_ toolName: String) -> String {
        switch toolName {
        case "read_file": return "read"
        case "write_file": return "write"
        case "edit", "edit_file": return "edit"
        case "bash": return "bash"
        case "browser": return "browser"
        case "javascript": return "javascript"
        case "send_message": return "message"
        case "feed_scoop": return "feed"
        case "scoop_scoop": return "scoop"
        case "drop_scoop": return "drop"
        case "scoop_mute": return "mute"
        case "scoop_unmute": return "unmute"
        case "scoop_wait": return "wait"
        case "list_scoops": return "list scoops"
        case "list_tasks": return "list tasks"
        case "register_scoop": return "register"
        case "schedule_task": return "schedule"
        case "update_global_memory": return "memory"
        case "delegate_to_scoop": return "delegate"
        default: return toolName
        }
    }

    

    
    
    static func lick(_ channel: String, sprinkleName: String? = nil) -> SliccGlyph {
        if channel == "sprinkle", let name = sprinkleName,
            let override = sprinkleIconOverrides[name]
        {
            return .system(override)
        }
        switch channel {
        case "webhook": return .system("bolt.horizontal.fill")  
        case "cron": return .system("calendar.badge.clock")  
        case "sprinkle": return .system("sparkles")  
        case "fswatch": return .system("eye")  
        case "navigate": return .system("safari")  
        case "session-reload": return .system("arrow.counterclockwise")  
        case "upgrade": return .system("arrow.up.circle.fill")  
        case "scoop-notify": return .system("bell.and.waves.left.and.right")  
        case "scoop-idle": return .system("moon")  
        case "scoop-wait": return .system("hourglass")  
        default: return .system("bell")  
        }
    }

    
    
    private static let sprinkleIconOverrides: [String: String] = [
        "welcome": "door.right.hand.open"
    ]

    

    
    
    
    
    
    
    
    
    static func sprinkle(iconSpec: String?) -> String {
        guard let spec = iconSpec?.trimmingCharacters(in: .whitespacesAndNewlines),
            isLucideName(spec)
        else { return "sparkles" }
        return lucideToSFSymbol[spec] ?? "sparkles"
    }

    
    
    static func isLucideName(_ spec: String) -> Bool {
        guard !spec.isEmpty else { return false }
        var previousWasDash = true
        for char in spec {
            if char == "-" {
                if previousWasDash { return false }
                previousWasDash = true
                continue
            }
            guard char.isASCII, char.isLowercase || char.isNumber else { return false }
            previousWasDash = false
        }
        return !previousWasDash
    }

    
    
    
    
    private static let lucideToSFSymbol: [String: String] = [
        "activity": "waveform.path.ecg",
        "alarm-clock": "alarm",
        "album": "square.stack",
        "atom": "atom",
        "award": "rosette",
        "banknote": "banknote",
        "bar-chart": "chart.bar",
        "bar-chart-3": "chart.bar",
        "battery": "battery.100",
        "bell": "bell",
        "book": "book",
        "book-open": "book",
        "bookmark": "bookmark",
        "bot": "cpu",
        "brain": "brain",
        "briefcase": "briefcase",
        "bug": "ladybug",
        "calculator": "plus.forwardslash.minus",
        "calendar": "calendar",
        "calendar-clock": "calendar.badge.clock",
        "camera": "camera",
        "check": "checkmark",
        "check-circle": "checkmark.circle",
        "chef-hat": "fork.knife",
        "circle-check": "checkmark.circle",
        "clipboard": "list.clipboard",
        "clipboard-list": "list.clipboard",
        "clock": "clock",
        "cloud": "cloud",
        "code": "chevron.left.forwardslash.chevron.right",
        "code-2": "chevron.left.forwardslash.chevron.right",
        "coffee": "cup.and.saucer",
        "compass": "safari",
        "cpu": "cpu",
        "credit-card": "creditcard",
        "database": "cylinder.split.1x2",
        "dice-5": "die.face.5",
        "dollar-sign": "dollarsign.circle",
        "download": "arrow.down.circle",
        "droplet": "drop",
        "dumbbell": "dumbbell",
        "eye": "eye",
        "file": "doc",
        "file-text": "doc.text",
        "film": "film",
        "flag": "flag",
        "flame": "flame",
        "flask-conical": "testtube.2",
        "folder": "folder",
        "gamepad-2": "gamecontroller",
        "gauge": "gauge.with.dots.needle.bottom.50percent",
        "gift": "gift",
        "git-branch": "arrow.triangle.branch",
        "github": "chevron.left.forwardslash.chevron.right",
        "globe": "globe",
        "graduation-cap": "graduationcap",
        "hammer": "hammer",
        "hash": "number",
        "headphones": "headphones",
        "heart": "heart",
        "home": "house",
        "house": "house",
        "image": "photo",
        "inbox": "tray",
        "info": "info.circle",
        "key": "key",
        "keyboard": "keyboard",
        "lamp": "lamp.desk",
        "layers": "square.3.layers.3d",
        "leaf": "leaf",
        "library": "books.vertical",
        "lightbulb": "lightbulb",
        "link": "link",
        "list": "list.bullet",
        "list-checks": "checklist",
        "list-todo": "checklist",
        "lock": "lock",
        "mail": "envelope",
        "map": "map",
        "map-pin": "mappin.and.ellipse",
        "megaphone": "megaphone",
        "message-circle": "message",
        "message-square": "bubble.left",
        "mic": "mic",
        "monitor": "display",
        "moon": "moon",
        "music": "music.note",
        "newspaper": "newspaper",
        "notebook": "book.closed",
        "package": "shippingbox",
        "palette": "paintpalette",
        "paperclip": "paperclip",
        "pen": "pencil",
        "pencil": "pencil",
        "phone": "phone",
        "pie-chart": "chart.pie",
        "pin": "pin",
        "plane": "airplane",
        "play": "play",
        "plug": "powerplug",
        "printer": "printer",
        "puzzle": "puzzlepiece",
        "quote": "quote.opening",
        "radio": "dot.radiowaves.left.and.right",
        "receipt": "receipt",
        "refresh-cw": "arrow.clockwise",
        "rocket": "paperplane",
        "rss": "dot.radiowaves.up.forward",
        "ruler": "ruler",
        "search": "magnifyingglass",
        "send": "paperplane.fill",
        "server": "server.rack",
        "settings": "gearshape",
        "shield": "shield",
        "shopping-bag": "bag",
        "shopping-cart": "cart",
        "shuffle": "shuffle",
        "sliders": "slider.horizontal.3",
        "smile": "face.smiling",
        "sparkles": "sparkles",
        "star": "star",
        "sticky-note": "note.text",
        "sun": "sun.max",
        "table": "tablecells",
        "tag": "tag",
        "target": "target",
        "terminal": "terminal",
        "thermometer": "thermometer.medium",
        "timer": "timer",
        "trash-2": "trash",
        "trending-up": "chart.line.uptrend.xyaxis",
        "trophy": "trophy",
        "truck": "truck.box",
        "tv": "tv",
        "umbrella": "umbrella",
        "upload": "arrow.up.circle",
        "user": "person",
        "users": "person.2",
        "utensils": "fork.knife",
        "video": "video",
        "wallet": "wallet.bifold",
        "wand-2": "wand.and.stars",
        "watch": "applewatch",
        "waves": "water.waves",
        "webhook": "bolt.horizontal.fill",
        "wifi": "wifi",
        "wrench": "wrench.adjustable",
        "zap": "bolt",
    ]

    
    
    static func lickLabel(_ channel: String) -> String {
        switch channel {
        case "webhook": return "webhook"
        case "cron": return "cron"
        case "sprinkle": return "sprinkle"
        case "fswatch": return "files"
        case "navigate": return "navigate"
        case "session-reload": return "reload"
        case "upgrade": return "upgrade"
        case "scoop-notify": return "scoop"
        case "scoop-idle": return "idle"
        case "scoop-wait": return "wait"
        default: return "event"
        }
    }

    

    static func messageSource(_ message: ChatMessage) -> SliccGlyph {
        if message.role == .user { return .system("person.crop.circle") }
        if let channel = message.channel, !channel.isEmpty {
            return lick(channel)
        }
        
        
        if message.source == "cone" { return .lucide(.iceCreamCone) }
        return .lucide(.iceCreamBowl)
    }

    

    
    static func attachment(_ kind: MessageAttachmentKind) -> String {
        switch kind {
        case .image: return "photo"  
        case .text: return "doc.text"  
        case .file: return "doc"  
        }
    }

    

    
    
    static func lickState(_ state: LickState) -> String? {
        switch state {
        case .pending: return nil
        case .confirmed: return "checkmark.circle"  
        case .dismissed: return "xmark.circle"  
        }
    }

    
    static func toolStatusColor(_ tc: ToolCall) -> Color {
        if tc.result == nil { return .yellow.opacity(0.8) }
        if tc.isError == true { return .red.opacity(0.8) }
        return .green.opacity(0.7)
    }
}
