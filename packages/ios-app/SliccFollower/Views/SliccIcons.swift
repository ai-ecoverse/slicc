import SwiftUI

/// SF Symbol mapping that mirrors the lucide icons used in the SLICC web UI
/// (`packages/webapp/src/ui/tool-call-view.ts`). Keep this in sync when new
/// tools or lick channels are added to the leader.
enum SliccIcons {

    // MARK: - Tool Icons (mirror tool-call-view.ts DESCRIPTORS)

    /// SF Symbol name for a tool call by its tool name. Falls back to a generic
    /// wrench when no specific mapping exists.
    static func tool(_ toolName: String) -> String {
        switch toolName {
        // File tools
        case "read_file":            return "doc.text"           // FileText
        case "write_file":           return "doc.badge.plus"     // FilePlus
        case "edit_file":            return "pencil"             // FilePen
        // Shell / scripting
        case "bash":                 return "terminal"           // Terminal
        case "browser":              return "globe"              // Globe
        case "javascript":           return "chevron.left.forwardslash.chevron.right" // Code2
        // Messaging / scoops
        case "send_message":         return "message.fill"       // MessageCircle
        case "feed_scoop":           return "fork.knife"         // UtensilsCrossed
        case "scoop_scoop":          return "cup.and.saucer.fill"// IceCreamCone (no SF cone)
        case "drop_scoop":           return "trash"              // Trash2
        case "scoop_mute":           return "speaker.slash"      // VolumeX
        case "scoop_unmute":         return "speaker.wave.2"     // Volume2
        case "scoop_wait":           return "hourglass"          // Hourglass
        case "list_scoops":          return "list.bullet"        // List
        case "list_tasks":           return "checklist"          // ListChecks
        case "register_scoop":       return "person.badge.plus"  // UserRoundPlus
        case "schedule_task":        return "clock"              // Clock
        case "update_global_memory": return "brain"              // BrainCog
        case "delegate_to_scoop":    return "paperplane.fill"    // Send
        default:                     return "wrench.and.screwdriver"
        }
    }

    /// Short lowercase noun describing a tool, mirroring the web UI titles.
    static func toolTitle(_ toolName: String) -> String {
        switch toolName {
        case "read_file":            return "read"
        case "write_file":           return "write"
        case "edit_file":            return "edit"
        case "bash":                 return "bash"
        case "browser":              return "browser"
        case "javascript":           return "javascript"
        case "send_message":         return "message"
        case "feed_scoop":           return "feed"
        case "scoop_scoop":          return "scoop"
        case "drop_scoop":           return "drop"
        case "scoop_mute":           return "mute"
        case "scoop_unmute":         return "unmute"
        case "scoop_wait":           return "wait"
        case "list_scoops":          return "list scoops"
        case "list_tasks":           return "list tasks"
        case "register_scoop":       return "register"
        case "schedule_task":        return "schedule"
        case "update_global_memory": return "memory"
        case "delegate_to_scoop":    return "delegate"
        default:                     return toolName
        }
    }

    // MARK: - Lick Channel Icons & Labels

    /// Icon for a lick channel (mirrors `packages/webapp/src/ui/lick-view.ts`).
    /// `sprinkleName` allows per-sprinkle overrides (e.g. "welcome" → door icon).
    static func lick(_ channel: String, sprinkleName: String? = nil) -> String {
        if channel == "sprinkle", let name = sprinkleName,
           let override = sprinkleIconOverrides[name] {
            return override
        }
        switch channel {
        case "webhook":         return "bolt.horizontal.fill"      // Webhook
        case "cron":            return "calendar.badge.clock"      // CalendarClock
        case "sprinkle":        return "sparkles"                  // Sparkles
        case "fswatch":         return "folder.badge.gearshape"    // FolderSync
        case "navigate":        return "safari"                    // Compass
        case "session-reload":  return "arrow.counterclockwise"    // RotateCcw
        case "upgrade":         return "arrow.up.circle.fill"      // ArrowUpCircle
        case "scoop-notify":    return "cup.and.saucer.fill"       // IceCream
        case "scoop-idle":      return "hourglass"                 // Hourglass
        case "scoop-wait":      return "checklist"                 // ListChecks
        default:                return "bell"                      // Bell
        }
    }

    /// Per-sprinkle icon overrides keyed by sprinkle name (matches
    /// `SPRINKLE_ICON_BY_NAME` in lick-view.ts).
    private static let sprinkleIconOverrides: [String: String] = [
        "welcome": "door.right.hand.open",
    ]

    /// Lowercase noun label for a lick channel — keeps the chat row reading
    /// like a tool-call row ("webhook github-push", "cron daily-digest", …).
    static func lickLabel(_ channel: String) -> String {
        switch channel {
        case "webhook":         return "webhook"
        case "cron":            return "cron"
        case "sprinkle":        return "sprinkle"
        case "fswatch":         return "files"
        case "navigate":        return "navigate"
        case "session-reload":  return "reload"
        case "upgrade":         return "upgrade"
        case "scoop-notify":    return "scoop"
        case "scoop-idle":      return "idle"
        case "scoop-wait":      return "wait"
        default:                return "event"
        }
    }

    // MARK: - Source Icons (cone vs scoop vs lick)

    static func messageSource(_ message: ChatMessage) -> String {
        if message.role == .user { return "person.crop.circle" }
        if let channel = message.channel, !channel.isEmpty {
            return lick(channel)
        }
        if message.source == "cone" { return "cup.and.saucer.fill" }
        return "circle.grid.2x2"
    }

    /// Color for tool status (mirrors the web UI's running/success/error tinting).
    static func toolStatusColor(_ tc: ToolCall) -> Color {
        if tc.result == nil { return .yellow.opacity(0.8) }
        if tc.isError == true { return .red.opacity(0.8) }
        return .green.opacity(0.7)
    }
}
