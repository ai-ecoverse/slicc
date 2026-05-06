import Foundation

/// UI fixture — synthetic chat history that exercises every message
/// variant the SwiftUI chat panel knows how to render. Mirrors the
/// webapp's `packages/webapp/src/ui/chat-fixture.ts` so designers and
/// reviewers can iterate on bubble / lick / sprinkle styling without
/// having to drive a real conversation through the leader.
///
/// Reachable from the sidebar's "UI Fixture" entry in DEBUG builds —
/// see `FixtureConversationView` in `ChatView.swift`. Renders alongside
/// the live conversation tab so designers can flip between live and
/// synthetic without disconnecting.
enum ChatFixture {
    /// Base timestamp — fixed so the rendered timeline is deterministic
    /// across reloads (no "5 seconds ago" drift while iterating on CSS).
    private static let baseTimestamp: Double = {
        var components = DateComponents()
        components.year = 2024
        components.month = 1
        components.day = 1
        components.hour = 10
        let date = Calendar(identifier: .gregorian).date(from: components) ?? Date()
        return date.timeIntervalSince1970 * 1000
    }()

    /// Advance the clock by `minutes` from the base timestamp.
    private static func ts(_ minutes: Double) -> Double {
        return baseTimestamp + minutes * 60_000
    }

    /// Build the fixture conversation. Pure function — no side effects.
    static func makeMessages() -> [ChatMessage] {
        var out: [ChatMessage] = []

        // 1. User + short assistant
        out.append(ChatMessage(
            id: "fx-user-1",
            role: .user,
            content: "Hey sliccy — can you summarize what this fixture covers?",
            timestamp: ts(0)
        ))
        out.append(ChatMessage(
            id: "fx-assistant-1",
            role: .assistant,
            content: """
                Sure! This session walks through every chat UI variant I know about. \
                You'll see user and assistant bubbles, tool calls in every status, \
                the six lick channels, a delegation, queued messages, and a streaming \
                tail at the end so you can inspect the live state.
                """,
            timestamp: ts(0.2)
        ))

        // 2. Markdown + code block + inline formatting
        out.append(ChatMessage(
            id: "fx-user-2",
            role: .user,
            content: "Show me some **markdown** — headings, lists, code, a blockquote.",
            timestamp: ts(1)
        ))
        out.append(ChatMessage(
            id: "fx-assistant-2",
            role: .assistant,
            content: """
                ## Rich content sample

                Here is a short list:

                - `renderAssistantMessageContent` handles GFM markdown
                - Code blocks get syntax highlighting
                - Inline `code` uses the mono token

                A fenced code block:

                ```swift
                func loadFixture() -> [ChatMessage] {
                    return ChatFixture.makeMessages()
                }
                ```

                > Blockquotes should feel quieter than regular text.
                """,
            timestamp: ts(1.3)
        ))

        // 3. Inline sprinkle (fenced shtml — exercises detection + CSS)
        out.append(ChatMessage(
            id: "fx-assistant-sprinkle",
            role: .assistant,
            content: """
                I prepared an upgrade card for you:

                ```shtml
                <div class="sprinkle-action-card">
                  <div class="sprinkle-action-card__header">
                    SLICC upgraded
                    <span class="sprinkle-badge sprinkle-badge--notice">2.29.0 → 2.29.1</span>
                  </div>
                  <div class="sprinkle-action-card__body">
                    <p>SLICC was upgraded. You can review what changed and optionally pull the new bundled workspace files into your VFS.</p>
                  </div>
                  <div class="sprinkle-action-card__actions">
                    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:'dismiss'})">Dismiss</button>
                    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick({action:'review-changelog'})">Review changelog</button>
                    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:'merge-vfs-root'})">Update workspace files</button>
                  </div>
                </div>
                ```
                """,
            timestamp: ts(1.8)
        ))

        // 3b. Bare-HTML sprinkle (no fence) — exercises bare-div detection
        out.append(ChatMessage(
            id: "fx-assistant-sprinkle-bare",
            role: .assistant,
            content: """
                Here's a status snapshot (emitted without a fence — mirrors what \
                the cone occasionally does):

                <div class="sprinkle-card">
                  <div class="sprinkle-row">
                    <span class="sprinkle-status-light sprinkle-status-light--positive">Build green</span>
                    <span class="sprinkle-badge sprinkle-badge--positive">Coverage 91%</span>
                  </div>
                </div>
                """,
            timestamp: ts(1.95)
        ))

        // 4. Tool calls in every status
        let toolRead = ToolCall(
            id: "fx-tc-read", name: "read_file",
            input: AnyCodable(["path": "/workspace/README.md"] as [String: Any]),
            result: "# Sample README\n\nThis is the contents that read_file returned.",
            isError: nil
        )
        let toolBash = ToolCall(
            id: "fx-tc-bash", name: "bash",
            input: AnyCodable(["command": "ls -la /workspace"] as [String: Any]),
            result: "total 24\ndrwxr-xr-x 4 user user 4096 Jan 01 10:00 .\n-rw-r--r-- 1 user user 187 Jan 01 10:00 README.md",
            isError: nil
        )
        let toolError = ToolCall(
            id: "fx-tc-err", name: "edit_file",
            input: AnyCodable(["path": "/workspace/missing.ts"] as [String: Any]),
            result: "ENOENT: no such file or directory, open \"/workspace/missing.ts\"",
            isError: true
        )
        let toolRunning = ToolCall(
            id: "fx-tc-run", name: "bash",
            input: AnyCodable(["command": "npm run test -- --coverage"] as [String: Any]),
            result: nil,
            isError: nil
        )
        out.append(ChatMessage(
            id: "fx-assistant-3", role: .assistant,
            content: "Let me check a few things before I answer.",
            timestamp: ts(2),
            toolCalls: [toolRead, toolBash, toolError, toolRunning]
        ))

        // 4b. Scoop management tool calls
        let toolList = ToolCall(
            id: "fx-tc-list", name: "list_scoops",
            input: nil,
            result: "Registered scoops:\n- sliccy (cone) [CONE] — ready\n- Hero Block (hero-block-scoop) — ready",
            isError: nil
        )
        let toolFeed = ToolCall(
            id: "fx-tc-feed", name: "feed_scoop",
            input: AnyCodable(["scoop_name": "hero-block-scoop"] as [String: Any]),
            result: "Task sent to hero-block-scoop. You will be notified when it completes.",
            isError: nil
        )
        out.append(ChatMessage(
            id: "fx-assistant-mgmt", role: .assistant,
            content: "Spinning up the scoops I need and handing out the work.",
            timestamp: ts(3),
            toolCalls: [toolList, toolFeed]
        ))

        // 5. Delegation
        out.append(ChatMessage(
            id: "fx-delegation-1", role: .user,
            content: "**[Instructions from sliccy]**\n\nRead `/workspace/README.md` and extract the install steps.",
            timestamp: ts(4),
            source: "delegation",
            channel: "delegation"
        ))
        out.append(ChatMessage(
            id: "fx-assistant-delegated", role: .assistant,
            content: "Extracted the install steps. Wrote them to `/shared/install.md`.",
            timestamp: ts(4.4),
            source: "cone"
        ))

        // 6. Licks — one per channel
        out.append(lick(
            id: "fx-lick-webhook",
            channel: "webhook",
            header: "[Webhook Event: github-push]",
            json: ["ref": "refs/heads/main", "head_commit": ["message": "fix(ui): tighten button contrast"]],
            at: 6
        ))
        out.append(lick(
            id: "fx-lick-cron",
            channel: "cron",
            header: "[Cron Event: daily-digest]",
            json: ["schedule": "0 9 * * *"],
            at: 8
        ))
        out.append(lick(
            id: "fx-lick-sprinkle",
            channel: "sprinkle",
            header: "[Sprinkle Event: welcome]",
            json: ["action": "onboarding-complete"],
            at: 10
        ))
        out.append(lick(
            id: "fx-lick-fswatch",
            channel: "fswatch",
            header: "[File Watch Event: src-watch]",
            json: ["changes": [["type": "modified", "path": "/workspace/src/app.ts"]]],
            at: 12
        ))
        out.append(lick(
            id: "fx-lick-navigate",
            channel: "navigate",
            header: "[Navigate Event: handoff]",
            json: ["url": "https://www.sliccy.ai/handoff?msg=demo"],
            at: 14
        ))
        out.append(lick(
            id: "fx-lick-upgrade",
            channel: "upgrade",
            header: "[Upgrade Event: 0.4.1\u{2192}0.5.0]",
            json: ["from": "0.4.1", "to": "0.5.0"],
            at: 17
        ))

        // 7. Queued messages + streaming tail
        out.append(ChatMessage(
            id: "fx-queued-1", role: .user,
            content: "Also double-check the install.md formatting after you finish.",
            timestamp: ts(18),
            queued: true
        ))
        out.append(ChatMessage(
            id: "fx-assistant-streaming", role: .assistant,
            content: "Great, running the coverage suite now. I'll report back as soon as it ",
            timestamp: ts(20),
            toolCalls: [
                ToolCall(
                    id: "fx-tc-streaming", name: "bash",
                    input: AnyCodable(["command": "npm run test -- --coverage"] as [String: Any]),
                    result: nil, isError: nil
                )
            ],
            isStreaming: true
        ))

        return out
    }

    /// Build a lick row with the standard `[Channel Event: name]\n```json …```` body.
    private static func lick(
        id: String,
        channel: String,
        header: String,
        json: Any,
        at minutes: Double
    ) -> ChatMessage {
        let bodyData = (try? JSONSerialization.data(
            withJSONObject: json,
            options: [.prettyPrinted, .sortedKeys]
        )) ?? Data()
        let body = String(data: bodyData, encoding: .utf8) ?? "{}"
        let content = "\(header)\n```json\n\(body)\n```"
        return ChatMessage(
            id: id, role: .user,
            content: content,
            timestamp: ts(minutes),
            source: "lick",
            channel: channel
        )
    }
}
