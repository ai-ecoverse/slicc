import FileProvider
import SliccTrayKit

@MainActor
final class FileProviderExtension: NSObject, @preconcurrency NSFileProviderReplicatedExtension {
    private let fsClient: FileProviderFSClientPool
    private let provider: LeaderVFSProvider

    required init(domain: NSFileProviderDomain) {
        let fsClient = FileProviderFSClientPool()
        self.fsClient = fsClient
        provider = LeaderVFSProvider(fs: fsClient)
        super.init()
    }

    func invalidate() {
        fsClient.disconnect()
    }

    func item(
        for identifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let task = Task { @MainActor in
            do {
                completionHandler(try await provider.item(for: identifier), nil)
            } catch {
                completionHandler(nil, VFSProviderErrorMapper.map(error))
            }
        }
        return progress(for: task)
    }

    func fetchContents(
        for itemIdentifier: NSFileProviderItemIdentifier,
        version requestedVersion: NSFileProviderItemVersion?,
        request: NSFileProviderRequest,
        completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let task = Task { @MainActor in
            do {
                let (data, item) = try await provider.fetchContents(for: itemIdentifier)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString, isDirectory: false)
                try data.write(to: url, options: .atomic)
                completionHandler(url, item, nil)
            } catch {
                completionHandler(nil, nil, VFSProviderErrorMapper.map(error))
            }
        }
        return progress(for: task)
    }

    func createItem(
        basedOn itemTemplate: NSFileProviderItem,
        fields: NSFileProviderItemFields,
        contents url: URL?,
        options: NSFileProviderCreateItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler:
            @escaping (
                NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?
            ) -> Void
    ) -> Progress {
        completionHandler(nil, [], false, unsupportedError())
        return completedProgress()
    }

    func modifyItem(
        _ item: NSFileProviderItem,
        baseVersion version: NSFileProviderItemVersion,
        changedFields: NSFileProviderItemFields,
        contents newContents: URL?,
        options: NSFileProviderModifyItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler:
            @escaping (
                NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?
            ) -> Void
    ) -> Progress {
        completionHandler(nil, [], false, unsupportedError())
        return completedProgress()
    }

    func deleteItem(
        identifier itemIdentifier: NSFileProviderItemIdentifier,
        baseVersion version: NSFileProviderItemVersion,
        options: NSFileProviderDeleteItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (Error?) -> Void
    ) -> Progress {
        completionHandler(unsupportedError())
        return completedProgress()
    }

    func enumerator(
        for containerItemIdentifier: NSFileProviderItemIdentifier,
        request: NSFileProviderRequest
    ) throws -> NSFileProviderEnumerator {
        try provider.enumerator(for: containerItemIdentifier)
    }

    private func progress(for task: Task<Void, Never>) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        progress.cancellationHandler = { task.cancel() }
        Task { @MainActor in
            await task.value
            progress.completedUnitCount = 1
        }
        return progress
    }

    private func completedProgress() -> Progress {
        let progress = Progress(totalUnitCount: 1)
        progress.completedUnitCount = 1
        return progress
    }

    private func unsupportedError() -> Error {
        NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError)
    }
}
