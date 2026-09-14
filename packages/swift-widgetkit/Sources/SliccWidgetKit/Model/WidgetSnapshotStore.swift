import Foundation












public struct WidgetSnapshotStore {
    
    
    
    
    public let appGroup: String
    
    public let fileName: String

    
    
    
    
    
    private let containerURL: (String) -> URL?

    public init(
        appGroup: String,
        fileName: String = "widget-snapshot.json",
        containerURL: @escaping (String) -> URL? = { group in
            FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        }
    ) {
        self.appGroup = appGroup
        self.fileName = fileName
        self.containerURL = containerURL
    }

    
    
    
    
    
    
    
    
    static let subdirectory = "Library"

    
    
    
    public var url: URL? {
        containerURL(appGroup)?
            .appendingPathComponent(Self.subdirectory)
            .appendingPathComponent(fileName)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    
    
    public static func encode(_ snapshot: WidgetSnapshot) throws -> Data {
        try encoder.encode(snapshot)
    }

    
    
    public static func decode(_ data: Data) throws -> WidgetSnapshot {
        let snapshot = try decoder.decode(WidgetSnapshot.self, from: data)
        guard snapshot.schema <= WidgetSnapshot.currentSchema else {
            throw WidgetSnapshotStoreError.futureSchema(snapshot.schema)
        }
        return snapshot
    }

    
    
    
    @discardableResult
    public func write(_ snapshot: WidgetSnapshot) throws -> URL {
        guard let url else { throw WidgetSnapshotStoreError.noContainer(appGroup) }
        
        
        
        
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Self.encode(snapshot).write(to: url, options: .atomic)
        return url
    }

    
    
    
    public func read() -> WidgetSnapshot? {
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? Self.decode(data)
    }

    
    
    public func clear() {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

public enum WidgetSnapshotStoreError: Error, Equatable {
    
    case noContainer(String)
    
    case futureSchema(Int)
}
