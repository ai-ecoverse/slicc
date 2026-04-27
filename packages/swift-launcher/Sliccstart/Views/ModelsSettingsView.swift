import SwiftUI
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "ModelsSettings")

/// Models tab: lets the user run / install / delete local LLMs served by
/// SwiftLM. Two sections — what's already in the HF cache, and a curated
/// catalog of recommended MLX models that one click can pull.
struct ModelsSettingsView: View {
    @Environment(SwiftLMProcess.self) private var swiftLM
    @Environment(ModelDownloadManager.self) private var downloads

    @State private var installed: [CachedModel] = []
    @State private var deletionTarget: CachedModel?
    @State private var startError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                installerStatusBanner
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
