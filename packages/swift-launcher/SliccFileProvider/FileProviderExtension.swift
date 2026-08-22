import FileProvider
import SliccTrayVFS

@MainActor
final class FileProviderExtension: NSObject, @preconcurrency NSFileProviderReplicatedExtension {
    private let fsClient: FileProviderFSClientPool
    private let provider: LeaderVFSProvider
    private let manager: NSFileProviderManager?
    private static let supportedMutationFields: NSFileProviderItemFields = [
        .contents, .filename, .parentItemIdentifier,
    ]

    required init(domain: NSFileProviderDomain) {
        let fsClient = FileProviderFSClientPool()
        self.fsClient = fsClient
        provider = LeaderVFSProvider(fs: fsClient)
        manager = NSFileProviderManager(for: domain)
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
        let task = Task { @MainActor in
            do {
                let contents = try url.map { try Data(contentsOf: $0) }
                let result = try await provider.createItem(
                    parentIdentifier: itemTemplate.parentItemIdentifier,
                    filename: itemTemplate.filename,
                    isDirectory: itemTemplate.contentType?.conforms(to: .folder) == true,
                    contents: contents)
                await signalEnumerators(result.containersToSignal)
                completionHandler(
                    result.item, fields.subtracting(Self.supportedMutationFields), false, nil)
            } catch {
                completionHandler(nil, [], false, VFSProviderErrorMapper.map(error))
            }
        }
        return progress(for: task)
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
        let task = Task { @MainActor in
            do {
                let contents = try newContents.map { try Data(contentsOf: $0) }
                let result = try await provider.modifyItem(
                    identifier: item.itemIdentifier,
                    parentIdentifier: item.parentItemIdentifier,
                    filename: item.filename,
                    contents: contents)
                await signalEnumerators(result.containersToSignal)
                completionHandler(
                    result.item, changedFields.subtracting(Self.supportedMutationFields), false, nil)
            } catch {
                completionHandler(nil, [], false, VFSProviderErrorMapper.map(error))
            }
        }
        return progress(for: task)
    }

    func deleteItem(
        identifier itemIdentifier: NSFileProviderItemIdentifier,
        baseVersion version: NSFileProviderItemVersion,
        options: NSFileProviderDeleteItemOptions = [],
        request: NSFileProviderRequest,
        completionHandler: @escaping (Error?) -> Void
    ) -> Progress {
        let task = Task { @MainActor in
            do {
                let result = try await provider.deleteItem(
                    identifier: itemIdentifier, recursive: options.contains(.recursive))
                await signalEnumerators(result.containersToSignal)
                completionHandler(nil)
            } catch {
                completionHandler(VFSProviderErrorMapper.map(error))
            }
        }
        return progress(for: task)
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

    private func signalEnumerators(_ identifiers: [NSFileProviderItemIdentifier]) async {
        guard let manager else { return }
        for identifier in identifiers {
            await withCheckedContinuation { continuation in
                manager.signalEnumerator(for: identifier) { _ in continuation.resume() }
            }
        }
    }
}
