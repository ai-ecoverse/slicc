import Foundation
import SliccTrayKit











enum ChatFixture {
    
    
    private static let baseTimestamp: Double = {
        var components = DateComponents()
        components.year = 2024
        components.month = 1
        components.day = 1
        components.hour = 10
        let date = Calendar(identifier: .gregorian).date(from: components) ?? Date()
        return date.timeIntervalSince1970 * 1000
    }()

    
    private static func ts(_ minutes: Double) -> Double {
        return baseTimestamp + minutes * 60_000
    }

    
    static func makeMessages() -> [ChatMessage] {
        var out: [ChatMessage] = []

        
        out.append(
            ChatMessage(
                id: "fx-user-1",
                role: .user,
                content: "Hey sliccy — can you summarize what this fixture covers?",
                timestamp: ts(0)
            ))
        out.append(
            ChatMessage(
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

        
        out.append(
            ChatMessage(
                id: "fx-user-2",
                role: .user,
                content: "Show me some **markdown** — headings, lists, code, a blockquote.",
                timestamp: ts(1)
            ))
        out.append(
            ChatMessage(
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
                    let SWIPE_ARBITRATION_CODE_BLOCK_TRAILING_EDGE_MARKER = ChatFixture.makeMessages()
                    ```

                    > Blockquotes should feel quieter than regular text.

                    | Float | Runtime | Agent | Notes |
                    | --- | :-: | --- | ---: |
                    | CLI | Express | yes | boots Chrome over CDP and keeps the bridge warm for the whole session |
                    | Cherry | iframe | no | embedded follower garnish |
                    """,
                timestamp: ts(1.3)
            ))

        
        out.append(
            ChatMessage(
                id: "fx-assistant-sprinkle",
                role: .assistant,
                content: """
                    I prepared an upgrade card for you:

                    ```shtml
                    <div class="sprinkle-action-card">
                      <div class="sprinkle-action-card__header">
                        Sliccy upgraded
                        <span class="sprinkle-badge sprinkle-badge--notice">2.29.0 → 2.29.1</span>
                      </div>
                      <div class="sprinkle-action-card__body">
                        <p>Sliccy was upgraded. You can review what changed and optionally pull the new bundled workspace files into your VFS.</p>
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

        
        out.append(
            ChatMessage(
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
        out.append(
            ChatMessage(
                id: "fx-assistant-3", role: .assistant,
                content: "Let me check a few things before I answer.",
                timestamp: ts(2),
                toolCalls: [toolRead, toolBash, toolError, toolRunning]
            ))

        
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
        out.append(
            ChatMessage(
                id: "fx-assistant-mgmt", role: .assistant,
                content: "Spinning up the scoops I need and handing out the work.",
                timestamp: ts(3),
                toolCalls: [toolList, toolFeed]
            ))

        
        out.append(
            ChatMessage(
                id: "fx-delegation-1", role: .user,
                content: "**[Instructions from sliccy]**\n\nRead `/workspace/README.md` and extract the install steps.",
                timestamp: ts(4),
                source: "delegation",
                channel: "delegation"
            ))
        out.append(
            ChatMessage(
                id: "fx-assistant-delegated", role: .assistant,
                content: "Extracted the install steps. Wrote them to `/shared/install.md`.",
                timestamp: ts(4.4),
                source: "cone"
            ))

        
        out.append(
            lick(
                id: "fx-lick-webhook",
                channel: "webhook",
                header: "[Webhook Event: github-push]",
                json: ["ref": "refs/heads/main", "head_commit": ["message": "fix(ui): tighten button contrast"]],
                at: 6
            ))
        out.append(
            lick(
                id: "fx-lick-cron",
                channel: "cron",
                header: "[Cron Event: daily-digest]",
                json: ["schedule": "0 9 * * *"],
                at: 8
            ))
        out.append(
            lick(
                id: "fx-lick-sprinkle",
                channel: "sprinkle",
                header: "[Sprinkle Event: welcome]",
                json: ["action": "onboarding-complete"],
                at: 10
            ))
        out.append(
            lick(
                id: "fx-lick-fswatch",
                channel: "fswatch",
                header: "[File Watch Event: src-watch]",
                json: ["changes": [["type": "modified", "path": "/workspace/src/app.ts"]]],
                at: 12
            ))
        out.append(
            lick(
                id: "fx-lick-navigate",
                channel: "navigate",
                header: "[Navigate Event: handoff]",
                
                json: ["url": "https://www.sliccy.ai/handoff?msg=demo"],
                at: 14
            ))
        out.append(
            lick(
                id: "fx-lick-upgrade",
                channel: "upgrade",
                header: "[Upgrade Event: 0.4.1\u{2192}0.5.0]",
                json: ["from": "0.4.1", "to": "0.5.0"],
                at: 17
            ))

        
        out.append(
            lick(
                id: "fx-lick-collated",
                channel: "webhook",
                header: "[Webhook Event: deploy-status]",
                json: ["run": 1],
                at: 17.2,
                count: 3,
                parts: (1...3).map {
                    lickContent(header: "[Webhook Event: deploy-status]", json: ["run": $0])
                }
            ))
        out.append(
            lick(
                id: "fx-lick-confirmed",
                channel: "sudo-request",
                header: "[Sudo Request: npm publish]",
                json: ["command": "npm publish --access public"],
                at: 17.4,
                state: .confirmed
            ))
        out.append(
            lick(
                id: "fx-lick-dismissed",
                channel: "sudo-request",
                header: "[Sudo Request: rm -rf node_modules]",
                json: ["command": "rm -rf node_modules"],
                at: 17.6,
                state: .dismissed
            ))

        
        out.append(
            ChatMessage(
                id: "fx-user-attachments", role: .user,
                content: "Here's the failing screen and the log.",
                timestamp: ts(17.7),
                attachments: [
                    MessageAttachment(
                        id: "fx-att-image", name: "screenshot.png",
                        mimeType: "image/png", size: 2048, kind: .image,
                        data: onePixelPNG
                    ),
                    MessageAttachment(
                        id: "fx-att-text", name: "build.log",
                        mimeType: "text/plain", size: 812, kind: .text,
                        text: "error TS2345: Argument of type 'string'…"
                    ),
                    MessageAttachment(
                        id: "fx-att-file", name: "heap-profile.cpuprofile",
                        mimeType: "application/octet-stream", size: 9_400_000, kind: .file,
                        path: "/workspace/uploads/heap-profile.cpuprofile",
                        error: "File too large to inline"
                    ),
                ]
            ))
        
        out.append(
            ChatMessage(
                id: "fx-user-attachment-only", role: .user,
                content: "",
                timestamp: ts(17.8),
                attachments: [
                    MessageAttachment(
                        id: "fx-att-solo", name: "diagram.png",
                        mimeType: "image/png", size: 1024, kind: .image,
                        data: onePixelPNG
                    )
                ]
            ))
        out.append(
            ChatMessage(
                id: "fx-assistant-error", role: .assistant,
                content: "Provider returned 429: rate limit exceeded. Retry after 30s.",
                timestamp: ts(17.9),
                error: true
            ))

        
        
        
        out.append(
            ChatMessage(
                id: "fx-assistant-progress", role: .assistant,
                content: "Fetching the archive and warming the caches.",
                timestamp: ts(18.5),
                toolCalls: [
                    ToolCall(
                        id: progressRowId, name: "bash",
                        input: AnyCodable(
                            ["command": "curl -O https://example.com/big.tar.gz"]
                                as [String: Any]),
                        result: nil, isError: nil
                    )
                ]
            ))
        out.append(
            ChatMessage(
                id: "fx-assistant-progress-cluster", role: .assistant,
                content: "Running the three checks in parallel.",
                timestamp: ts(18.7),
                toolCalls: [
                    ToolCall(
                        id: clusterRowIds[0], name: "bash",
                        input: AnyCodable(["command": "npm run lint"] as [String: Any]),
                        result: "0 problems", isError: nil
                    ),
                    ToolCall(
                        id: clusterRowIds[1], name: "bash",
                        input: AnyCodable(["command": "npm run typecheck"] as [String: Any]),
                        result: nil, isError: nil
                    ),
                    ToolCall(
                        id: clusterRowIds[2], name: "bash",
                        input: AnyCodable(["command": "npm run test"] as [String: Any]),
                        result: nil, isError: nil
                    ),
                ]
            ))

        
        
        
        out.append(contentsOf: compactionMarkers())

        
        out.append(
            ChatMessage(
                id: "fx-queued-1", role: .user,
                content: "Also double-check the install.md formatting after you finish.",
                timestamp: ts(18.5),
                queued: true
            ))
        out.append(
            ChatMessage(
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

    

    
    
    
    private static func compactionMarkers() -> [ChatMessage] {
        let snapshot = "/sessions/live-cone-fixture-8egf.md"
        return [
            ChatMessage(
                id: "fx-compaction-idle", role: .assistant, content: "", timestamp: ts(18.1),
                compaction: ChatCompactionMarker(
                    trigger: .idle, state: .summarized, transcriptPath: snapshot)),
            ChatMessage(
                id: "fx-compaction-threshold-running", role: .assistant, content: "",
                timestamp: ts(18.2),
                compaction: ChatCompactionMarker(
                    trigger: .threshold, state: .summarizing, transcriptPath: snapshot)),
            
            ChatMessage(
                id: "fx-compaction-fallback", role: .assistant, content: "", timestamp: ts(18.3),
                compaction: ChatCompactionMarker(trigger: .overflow, state: .fallback)),
        ]
    }

    

    
    
    
    private static let progressRowId = "fx-assistant-progress:call-curl"
    private static let clusterRowIds = [
        "fx-assistant-progress-cluster:call-lint",
        "fx-assistant-progress-cluster:call-typecheck",
        "fx-assistant-progress-cluster:call-test",
    ]

    
    
    
    static let toolProgress: [String: ToolProgressEvent] = [
        progressRowId: ToolProgressEvent(
            id: "curl-1", label: "curl …/big.tar.gz", fraction: 0.43, etaMs: 8_000,
            done: 45_678_901, total: 106_000_000, unit: "bytes", phase: .update),
        clusterRowIds[1]: ToolProgressEvent(
            id: "tsc-1", label: "tsc --noEmit", fraction: 0.72, etaMs: 21_000,
            phase: .update),
        clusterRowIds[2]: ToolProgressEvent(
            id: "vitest-1", label: "vitest run", phase: .start),
    ]

    
    private static func lick(
        id: String,
        channel: String,
        header: String,
        json: Any,
        at minutes: Double,
        count: Int? = nil,
        parts: [String]? = nil,
        state: LickState? = nil
    ) -> ChatMessage {
        let content = lickContent(header: header, json: json)
        return ChatMessage(
            id: id, role: .user,
            content: content,
            timestamp: ts(minutes),
            source: "lick",
            channel: channel,
            lickCount: count,
            lickParts: parts,
            lickState: state
        )
    }

    
    
    
    
    
    
    
    
    static func makeShortActionMessages() -> [ChatMessage] {
        let write = ToolCall(
            id: "fx-actions:call-write",
            name: "write_file",
            input: AnyCodable(["path": "/workspace/notes/handoff.md", "content": "# Handoff"]),
            result: "wrote 9 bytes"
        )
        return [
            ChatMessage(
                id: "fx-actions-user",
                role: .user,
                content: "Where did you put the handoff, and who do I call about it?",
                timestamp: ts(0)
            ),
            ChatMessage(
                id: "fx-actions-assistant",
                role: .assistant,
                content: """
                    I wrote it to handoff.md — run `npm run build -w @slicc/webapp` first, \
                    then read it. The runbook is at packages/ios-app/CLAUDE.md.

                    ```bash
                    cat /workspace/notes/handoff.md | pbcopy
                    ```

                    Background: [the architecture note](https://sliccy.ai/docs/architecture) \
                    and mailto:ops@sliccy.ai. If it is urgent, call +1 (415) 555-0134.

                    Here is the icon I generated:

                    data:image/png;base64,\(noisePNG)

                    And the note itself, encoded:

                    \(encodedNote)
                    """,
                timestamp: ts(0.2),
                toolCalls: [write]
            ),
        ]
    }

    
    
    private static let noisePNG =
        "iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAAB9UlEQVR42u3dMQ2AMABE0fqoAwZWtGACb11QUBO1gQIMwNrk0pd8"
        + "ATe8/cp1jrj2fsf1tCOuWre4CtBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQ"
        + "QAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQ"
        + "QAMN9OKgE3FIfwEtoCWgJaAloAW0BLQEtAS0BLSAloCWgJaAloAW0BLQEtAS0BLQAloCWgJaAloCWkBLQEtAS0BLQAtoCWgJaAlo"
        + "CWgBLQEtAS0BrdVBO96ck+NNT7JAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQ"
        + "QAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQQAMNNNBAAw000EADDTTQ"
        + "QAMNNNAzQCeOloAW0BLQEtAS0BLQAloCWgJaAloCWkBLQEtAS0BLQAtoCWgJaAloAS0BLQEtAS0BLaAloCWgJaAloAW0BLQEtAS0"
        + "BLSAloCWgJaAlj57AcfNe/5HMj6nAAAAAElFTkSuQmCC"

    
    
    private static let encodedNote =
        "VGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZywgYW5kIHRoZW4ga2VlcHMgb24ganVtcGluZyB1bnRp"
        + "bCB0aGlzIHNlbnRlbmNlIGlzIGNvbWZvcnRhYmx5IGxvbmdlciB0aGFuIHRoZSBodW5kcmVkIGFuZCB0d2VudHkgZWlnaHQgY2hh"
        + "cmFjdGVyIGZsb29yLg=="

    
    
    private static let onePixelPNG =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

    
    
    static let toolUIHtml = """
        <div class="sprinkle-action-card">
          <div class="sprinkle-action-card__header">
            <span class="sprinkle-badge">sudo</span>
            Allow <code>npm publish</code>?
            <div class="sprinkle-action-card__meta">/workspace/package.json</div>
          </div>
          <button>Approve</button>
        </div>
        """

    
    private static func lickContent(header: String, json: Any) -> String {
        let bodyData =
            (try? JSONSerialization.data(
                withJSONObject: json,
                options: [.prettyPrinted, .sortedKeys]
            )) ?? Data()
        let body = String(data: bodyData, encoding: .utf8) ?? "{}"
        return "\(header)\n```json\n\(body)\n```"
    }
}
