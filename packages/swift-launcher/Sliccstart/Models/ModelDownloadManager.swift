import Foundation
import HuggingFace
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "ModelDownloadManager")

/// State for a single in-flight or recently-finished model snapshot pull.
struct ModelDownloadStatus: Equatable {
    enum Stage: Equatable {
        case running(fraction: Double)
        case completed
        case failed(message: String)
        case cancelled
    }

    let repoId: String
    let stage: Stage
}

/// Drives `HubClient.downloadSnapshot` for one or more repos in parallel and
/// publishes per-repo progress. Used by the Models tab's Install buttons.
///
/// `swift-huggingface` writes to the standard `~/.cache/huggingface/hub`
/// cache, so anything pulled here is also visible to the system `hf` CLI
/// and to SwiftLM (which resolves models from the same location).
@Observable
@MainActor
final class ModelDownloadManager {
    private(set) var statuses: [String: ModelDownloadStatus] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    private let client = HubClient.default

    func status(for repoId: String) -> ModelDownloadStatus? {
        statuses[repoId]
    }

    func isInFlight(_ repoId: String) -> Bool {
        if case .running = statuses[repoId]?.stage { return true }
        return false
    }

    func install(_ repoId: String) {
        guard !isInFlight(repoId) else { return }
        statuses[repoId] = .init(repoId: repoId, stage: .running(fraction: 0))

        let task = Task<Void, Never> { [weak self] in
            await self?.run(repoId: repoId)
        }
        tasks[repoId] = task
    }

    func cancel(_ repoId: String) {
        tasks[repoId]?.cancel()
        tasks[repoId] = nil
        statuses[repoId] = .init(repoId: repoId, stage: .cancelled)
    }

    func clear(_ repoId: String) {
        tasks[repoId] = nil
        statuses[repoId] = nil
    }

    private func run(repoId: String) async {
        do {
            _ = try await client.downloadSnapshot(
                of: Repo.ID(rawValue: repoId)!,
                progressHandler: { [weak self] progress in
                    let fraction = progress.totalUnitCount > 0
                        ? Double(progress.completedUnitCount) / Double(progress.totalUnitCount)
                        : 0
                    self?.statuses[repoId] = .init(repoId: repoId, stage: .running(fraction: fraction))
                }
            )
            if Task.isCancelled {
                statuses[repoId] = .init(repoId: repoId, stage: .cancelled)
            } else {
                statuses[repoId] = .init(repoId: repoId, stage: .completed)
            }
        } catch is CancellationError {
            statuses[repoId] = .init(repoId: repoId, stage: .cancelled)
        } catch {
            log.error("download failed for \(repoId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            statuses[repoId] = .init(repoId: repoId, stage: .failed(message: error.localizedDescription))
        }
        tasks[repoId] = nil
    }
}
