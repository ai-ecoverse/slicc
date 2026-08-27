import SliccTrayKit
import SwiftUI

/// SF Symbol mapping that mirrors the lucide icons used in the SLICC web UI
/// (`packages/webapp/src/ui/tool-call-view.ts`). Keep this in sync when new
/// tools or lick channels are added to the leader.
enum SliccIcons {

    // MARK: - Tool Icons (mirror TOOL_ICONS in wc-message-view.ts)

    /// Glyph for a tool call by its tool name. Falls back to a generic wrench
    /// when no specific mapping exists. Ice-cream tools use the ported Lucide
    /// cone — SF Symbols has no cone, and a teacup was the previous stand-in.
    static func tool(_ toolName: String) -> SliccGlyph {
        switch toolName {
        // File tools
        case "read_file": return .system("doc.text")  // FileText
        case "write_file": return .system("doc.badge.plus")  // FilePlus
        case "edit_file": return .system("pencil")  // FilePen
        // Shell / scripting
        case "bash": return .system("terminal")  // Terminal
        case "browser": return .system("globe")  // Globe
        case "javascript": return .system("chevron.left.forwardslash.chevron.right")  // Code2
        // Messaging / scoops
        case "send_message": return .system("message.fill")  // MessageCircle
        case "feed_scoop": return .system("fork.knife")  // Utensils
        case "scoop_scoop": return .lucide(.iceCreamCone)  // IceCreamCone
        case "drop_scoop": return .system("trash")  // Trash2
        case "scoop_mute": return .system("bell.slash")  // BellOff
        case "scoop_unmute": return .system("bell.and.waves.left.and.right")  // BellRing
        case "scoop_wait": return .system("hourglass")  // Hourglass
        case "list_scoops": return .lucide(.iceCreamCone)  // IceCreamCone
        case "list_tasks": return .system("checklist")  // ListChecks
        case "register_scoop": return .system("person.badge.plus")  // UserRoundPlus
        case "schedule_task": return .system("clock")  // Clock
        case "update_global_memory": return .system("brain")  // Brain
        case "delegate_to_scoop": return .system("paperplane.fill")  // Send
        default: return .system("wrench.and.screwdriver")
        }
    }

    /// Short lowercase noun describing a tool, mirroring the web UI titles.
    static func toolTitle(_ toolName: String) -> String {
        switch toolName {
        case "read_file": return "read"
        case "write_file": return "write"
        case "edit_file": return "edit"
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

    // MARK: - Lick Channel Icons & Labels

    /// Icon for a lick channel (mirrors `KIND_ICON` in slicc-lick-card.ts).
    /// `sprinkleName` allows per-sprinkle overrides (e.g. "welcome" → door icon).
    static func lick(_ channel: String, sprinkleName: String? = nil) -> SliccGlyph {
        if channel == "sprinkle", let name = sprinkleName,
            let override = sprinkleIconOverrides[name]
        {
            return .system(override)
        }
        switch channel {
        case "webhook": return .system("bolt.horizontal.fill")  // Webhook
        case "cron": return .system("calendar.badge.clock")  // CalendarClock
        case "sprinkle": return .system("sparkles")  // Sparkles
        case "fswatch": return .system("eye")  // Eye
        case "navigate": return .system("safari")  // Compass
        case "session-reload": return .system("arrow.counterclockwise")  // RotateCcw
        case "upgrade": return .system("arrow.up.circle.fill")  // CircleArrowUp
        case "scoop-notify": return .system("bell.and.waves.left.and.right")  // BellRing
        case "scoop-idle": return .system("moon")  // Moon
        case "scoop-wait": return .system("hourglass")  // Hourglass
        default: return .system("bell")  // Bell
        }
    }

    /// Per-sprinkle icon overrides keyed by sprinkle name (matches
    /// `SPRINKLE_ICON_BY_NAME` in lick-view.ts).
    private static let sprinkleIconOverrides: [String: String] = [
        "welcome": "door.right.hand.open"
    ]

    // MARK: - Sprinkle Rail Icons

    /// SF Symbol for a sprinkle's declared icon spec (`SprinkleSummary.icon`,
    /// sourced from `data-sprinkle-icon` / `<link rel="icon">` on the leader).
    ///
    /// The web rail renders lucide kebab names directly; the phone maps the
    /// ones lucide and SF Symbols agree on and falls back to the generic
    /// sparkle otherwise. Non-lucide specs (VFS paths, inline `<svg>`,
    /// `data:` URLs) also fall back — the web dock item skips those too
    /// (`isLucideIconSpec` in `wc-sprinkles.ts`).
    static func sprinkle(iconSpec: String?) -> String {
        guard let spec = iconSpec?.trimmingCharacters(in: .whitespacesAndNewlines),
            isLucideName(spec)
        else { return "sparkles" }
        return lucideToSFSymbol[spec] ?? "sparkles"
    }

    /// Mirrors `isLucideIconSpec` in `wc-sprinkles.ts`: lowercase kebab only.
    /// Anything else is a path, inline SVG or data URL.
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

    /// Lucide kebab name → SF Symbol. Covers the icons sprinkles in the
    /// tray actually declare plus the ones the leader's LLM enrichment
    /// reaches for; unmapped names degrade to `sparkles` rather than to a
    /// missing-glyph box.
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

    /// Lowercase noun label for a lick channel — keeps the chat row reading
    /// like a tool-call row ("webhook github-push", "cron daily-digest", …).
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

    // MARK: - Source Icons (cone vs scoop vs lick)

    static func messageSource(_ message: ChatMessage) -> SliccGlyph {
        if message.role == .user { return .system("person.crop.circle") }
        if let channel = message.channel, !channel.isEmpty {
            return lick(channel)
        }
        // Match ConeScoopGlyph / the web rail: cone and scoop are ice cream,
        // never a teacup or a 2×2 grid.
        if message.source == "cone" { return .lucide(.iceCreamCone) }
        return .lucide(.iceCreamBowl)
    }

    // MARK: - Attachments (mirror ATTACHMENT_ICON in slicc-user-message.ts)

    /// SF Symbol for an attachment chip that has no inline image to show.
    static func attachment(_ kind: MessageAttachmentKind) -> String {
        switch kind {
        case .image: return "photo"  // lucide image
        case .text: return "doc.text"  // lucide file-text
        case .file: return "doc"  // lucide file
        }
    }

    // MARK: - Lick State (mirror STATE_ICON in slicc-lick-card.ts)

    /// SF Symbol for a settled lick decision. `pending` has no glyph on the
    /// web either — the card simply stays in its default form.
    static func lickState(_ state: LickState) -> String? {
        switch state {
        case .pending: return nil
        case .confirmed: return "checkmark.circle"  // lucide circle-check
        case .dismissed: return "xmark.circle"  // lucide circle-x
        }
    }

    /// Color for tool status (mirrors the web UI's running/success/error tinting).
    static func toolStatusColor(_ tc: ToolCall) -> Color {
        if tc.result == nil { return .yellow.opacity(0.8) }
        if tc.isError == true { return .red.opacity(0.8) }
        return .green.opacity(0.7)
    }
}
