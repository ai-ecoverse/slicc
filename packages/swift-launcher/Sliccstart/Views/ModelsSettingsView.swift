import SwiftUI
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "ModelsSettings")

/// Models tab: lets the user run / install / delete local LLMs served by
/// SwiftLM. Two sections — what's already in the HF cache, and a curated
/// catalog of recommended MLX models that one click can pull.
struct ModelsSettingsView: View {
    @Environment(SwiftLMProcess.self) private var swiftLM
    @Environment(ModelDownloadManager.self) private var downloads
    @AppStorage(autoRunModelIdKey) private var autoRunModelId: String = ""
    @AppStorage(swiftLMContextSizeKey) private var swiftLMContextSize: Int = 0

    @State private var installed: [CachedModel] = []
    @State private var deletionTarget: CachedModel?
    @State private var startError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                installerStatusBanner
                autoRunSection
                contextSizeSection
                installedSection
                suggestedSection
            }
            .padding(20)
        }
        .frame(width: 620, height: 480)
        .onAppear { reload() }
        .onChange(of: swiftLM.installerState) { reload() }
        .onChange(of: swiftLM.state) { reload() }
        .alert(
            "Delete model?",
            isPresented: Binding(
                get: { deletionTarget != nil },
                set: { if !$0 { deletionTarget = nil } }
            ),
            presenting: deletionTarget
        ) { target in
            Button("Cancel", role: .cancel) { deletionTarget = nil }
            Button("Delete", role: .destructive) {
                delete(target)
                deletionTarget = nil
            }
        } message: { target in
            Text("Remove \(target.repoId) from your HuggingFace cache (\(target.sizeBytes.humanByteSize))? This frees disk space and can be re-downloaded later.")
        }
        .alert(
            "Couldn't start model",
            isPresented: Binding(
                get: { startError != nil },
                set: { if !$0 { startError = nil } }
            )
        ) {
            Button("OK") { startError = nil }
        } message: {
            Text(startError ?? "")
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var installerStatusBanner: some View {
        switch swiftLM.installerState {
        case .downloading(let fraction):
            HStack {
                ProgressView(value: fraction)
                Text("Downloading SwiftLM \(SwiftLMVersion.pinned)…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .extracting:
            HStack {
                ProgressView()
                Text("Extracting SwiftLM…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .failed(let message):
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                Text("SwiftLM install failed: \(message)")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        case .idle, .ready:
            EmptyView()
        }
    }

    /// Picker that designates one installed model as the auto-run target
    /// at Sliccstart launch. Mirrors the Startup tab's auto-launch
    /// browser picker — same `@AppStorage` pattern, same "None ▾" idiom.
    /// Only installed models populate the list, since auto-run kicks off
    /// `swiftLM.start(model:)` directly and a missing model would either
    /// silently no-op or trigger a multi-GB blocking download at launch.
    /// If the saved model later disappears (user clicked Delete), we
    /// reset the picker to "None" so the menu always reflects what can
    /// actually run.
    private var autoRunSection: some View {
        HStack(spacing: 8) {
            Text("Auto-run on launch:")
                .font(.callout)
            Picker(selection: $autoRunModelId) {
                Text("None").tag("")
                if !installed.isEmpty {
                    Divider()
                    ForEach(installed) { model in
                        Text(model.repoId).tag(model.repoId)
                    }
                }
            } label: {
                EmptyView()
            }
            .pickerStyle(.menu)
            .labelsHidden()
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
    }

    /// Picker that overrides SwiftLM's `--ctx-size`. Hard-capped at
    /// 75 % of physical RAM at launch (see `ContextWindowPolicy`),
    /// regardless of what the user picks here — but a smaller user
    /// choice is honored, since trimming the context window is a
    /// reasonable knob to turn when the model is OOM-thrashing.
    /// Default ("Auto") delegates to `ContextWindowPolicy.autoDefault`.
    private var contextSizeSection: some View {
        HStack(spacing: 8) {
            Text("Context window:")
                .font(.callout)
            Picker(selection: $swiftLMContextSize) {
                ForEach(ContextWindowPolicy.pickerChoices, id: \.self) { choice in
                    Text(label(forContextSize: choice)).tag(choice)
                }
            } label: {
                EmptyView()
            }
            .pickerStyle(.menu)
            .labelsHidden()
            Spacer()
            Text("Capped at 75 % of system RAM")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
    }

    /// Render token counts as Auto / 8K / 16K / 32K / 64K / 128K / 256K
    /// to match how everyone (HF model cards, OpenAI docs, the ML
    /// research community) writes them.
    private func label(forContextSize tokens: Int) -> String {
        guard tokens > 0 else { return "Auto" }
        if tokens >= 1024 && tokens.isMultiple(of: 1024) {
            return "\(tokens / 1024)K"
        }
        return "\(tokens)"
    }

    private var installedSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Installed").font(.headline)
                Spacer()
                if let loaded = swiftLM.loadedModel {
                    HStack(spacing: 6) {
                        Circle().fill(.green).frame(width: 7, height: 7)
                        Text("Serving \(loaded)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if installed.isEmpty {
                Text("No MLX models cached yet. Pick one from Suggested below to install it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    ForEach(installed) { model in
                        InstalledModelRow(
                            model: model,
                            isRunning: swiftLM.loadedModel == model.repoId,
                            otherRunning: swiftLM.isRunning && swiftLM.loadedModel != model.repoId,
                            isStarting: isStarting(model.repoId),
                            onRun: { run(model.repoId) },
                            onStop: { swiftLM.stop() },
                            onDelete: { deletionTarget = model }
                        )
                        if model != installed.last {
                            Divider().padding(.leading, 12)
                        }
                    }
                }
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(.separator, lineWidth: 0.5)
                )
            }
        }
    }

    private var suggestedSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Suggested").font(.headline)
            VStack(spacing: 0) {
                let suggestions = SuggestedModels.all
                ForEach(suggestions) { model in
                    SuggestedModelRow(
                        model: model,
                        installState: installState(for: model.repoId),
                        onInstall: { downloads.install(model.repoId) },
                        onCancel: { downloads.cancel(model.repoId) }
                    )
                    if model != suggestions.last {
                        Divider().padding(.leading, 12)
                    }
                }
            }
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(.separator, lineWidth: 0.5)
            )
        }
    }

    // MARK: - Logic

    private func reload() {
        installed = HFCache.listInstalledMLXModels()
        // If the saved auto-run model has been deleted from the cache,
        // drop the setting so the picker shows "None" instead of a stale
        // tag that wouldn't match any of the available rows. Empty
        // string is the canonical "no auto-run" value.
        if !autoRunModelId.isEmpty,
           !installed.contains(where: { $0.repoId == autoRunModelId })
        {
            autoRunModelId = ""
        }
    }

    private func isStarting(_ repoId: String) -> Bool {
        if case .starting = swiftLM.state, swiftLM.loadedModel == nil {
            // We don't yet track which model is mid-launch separately from
            // the running model; conservatively show the spinner on every
            // row while .starting until state advances.
            return true
        }
        return false
    }

    private func run(_ repoId: String) {
        Task {
            do {
                try await swiftLM.start(model: repoId)
            } catch {
                log.error("start failed: \(error.localizedDescription, privacy: .public)")
                startError = error.localizedDescription
            }
        }
    }

    private func delete(_ model: CachedModel) {
        if swiftLM.loadedModel == model.repoId {
            swiftLM.stop()
        }
        do {
            try HFCache.delete(repoId: model.repoId)
            reload()
        } catch {
            startError = "Couldn't delete \(model.repoId): \(error.localizedDescription)"
        }
    }

    private func installState(for repoId: String) -> SuggestedInstallState {
        if installed.contains(where: { $0.repoId == repoId }) {
            return .installed
        }
        if let status = downloads.status(for: repoId) {
            switch status.stage {
            case .running(let fraction): return .downloading(fraction: fraction)
            case .completed:
                // Re-scan should pick this up; in the meantime treat as
                // installed so the row reflects reality immediately.
                return .installed
            case .failed(let message): return .failed(message: message)
            case .cancelled: return .available
            }
        }
        return .available
    }
}

// MARK: - Row views

enum SuggestedInstallState: Equatable {
    case available
    case downloading(fraction: Double)
    case installed
    case failed(message: String)
}

private struct InstalledModelRow: View {
    let model: CachedModel
    let isRunning: Bool
    let otherRunning: Bool
    let isStarting: Bool
    let onRun: () -> Void
    let onStop: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.repoId)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(model.sizeBytes.humanByteSize)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if isRunning {
                Button("Stop", action: onStop)
            } else if isStarting {
                ProgressView().controlSize(.small)
            } else {
                Button("Run", action: onRun)
                    .disabled(otherRunning)
                    .help(otherRunning ? "Stop the running model first." : "")
            }
            Button {
                onDelete()
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .disabled(isRunning)
            .help(isRunning ? "Stop before deleting." : "Delete from HuggingFace cache")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

private struct SuggestedModelRow: View {
    let model: SuggestedModel
    let installState: SuggestedInstallState
    let onInstall: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.repoId)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(model.summary)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(model.note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if case .downloading(let fraction) = installState {
                    ProgressView(value: fraction)
                        .progressViewStyle(.linear)
                        .padding(.top, 2)
                } else if case .failed(let message) = installState {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("~\(Int(model.approxSizeGB)) GB")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                trailingButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var trailingButton: some View {
        switch installState {
        case .available, .failed:
            Button("Install", action: onInstall)
        case .downloading:
            Button("Cancel", action: onCancel)
        case .installed:
            Text("Installed")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
