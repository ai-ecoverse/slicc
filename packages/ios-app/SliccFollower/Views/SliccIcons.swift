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

    // MARK: - Lick Channel Icons

    /// Icon for a lick channel (webhook, cron, sprinkle, fswatch, navigate, session-reload).
    static func lick(_ channel: String) -> String {
        switch channel {
        case "webhook":         return "antenna.radiowaves.left.and.right"
        case "cron":            return "clock.arrow.2.circlepath"
        case "sprinkle":        return "sparkles"
        case "fswatch":         return "eye"
        case "navigate":        return "arrow.up.right.square"
        case "session-reload":  return "arrow.clockwise.circle"
        default:                return "bolt"
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
