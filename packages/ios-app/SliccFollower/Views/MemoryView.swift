import SwiftUI

/// The dock's `memory` surface (#1867): the cone's `/workspace/CLAUDE.md`
/// read over the tray (`fs.request` → leader VFS, the same two-method
/// proxy the sprinkle path uses) and rendered as tagged rows — the same
/// model as the web memory surface (`wc-memory.ts`), read-only like every
/// follower surface.
struct MemoryView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette

    private enum LoadState: Equatable {
        case loading
        case loaded([MemoryRow])
        case failed(String)
    }

    @State private var state: LoadState = .loading

    var body: some View {
        Group {
            switch state {
            case .loading:
                ProgressView("Reading the leader's memory…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let reason):
                VStack(spacing: 12) {
                    Image(systemName: "brain")
                        .font(.system(size: 32))
                        .foregroundStyle(palette.inkTertiary)
                    Text(reason)
                        .font(.system(size: 14))
                        .foregroundStyle(palette.inkSecondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("memory-error")
                }
                .padding(.horizontal, 40)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loaded(let rows):
                if rows.isEmpty {
                    Text("The leader's memory is empty.")
                        .foregroundStyle(palette.inkSecondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityIdentifier("memory-empty")
                } else {
                    rowList(rows)
                }
            }
        }
        .background(palette.canvas)
        .task { await load() }
    }

    private func rowList(_ rows: [MemoryRow]) -> some View {
        List {
            ForEach(groupedSections(rows), id: \.section) { group in
                Section(group.section.isEmpty ? "Memory" : group.section) {
                    ForEach(group.rows) { row in
                        DisclosureGroup {
                            MarkdownText(content: row.body)
                                .padding(.vertical, 4)
                        } label: {
                            HStack(spacing: 8) {
                                if let tag = row.tag {
                                    Text(tag.rawValue)
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(tagColor(tag).opacity(0.18))
                                        .foregroundStyle(tagColor(tag))
                                        .clipShape(Capsule())
                                }
                                Text(row.title)
                                    .font(.system(size: 14))
                                    .lineLimit(2)
                            }
                        }
                        .accessibilityIdentifier("memory-row-\(row.id)")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func groupedSections(_ rows: [MemoryRow]) -> [(section: String, rows: [MemoryRow])] {
        var order: [String] = []
        var bySection: [String: [MemoryRow]] = [:]
        for row in rows {
            if bySection[row.section] == nil { order.append(row.section) }
            bySection[row.section, default: []].append(row)
        }
        return order.map { ($0, bySection[$0] ?? []) }
    }

    private func tagColor(_ tag: MemoryRow.Tag) -> Color {
        switch tag {
        case .user: return .blue
        case .feedback: return .orange
        case .project: return palette.accent
        }
    }

    private func load() async {
        #if DEBUG
            if let fixture = UITestHooks.memoryFixtureMarkdown() {
                state = .loaded(MemoryStore.parse(fixture))
                return
            }
        #endif
        guard appState.connectionState == .connected else {
            state = .failed("Memory lives on the leader — connect to a session to read it.")
            return
        }
        do {
            let markdown = try await appState.fsClient.readFile(MemoryStore.memoryPath)
            state = .loaded(MemoryStore.parse(markdown))
        } catch {
            state = .failed(
                "Could not read \(MemoryStore.memoryPath) from the leader: \(error.localizedDescription)")
        }
    }
}
