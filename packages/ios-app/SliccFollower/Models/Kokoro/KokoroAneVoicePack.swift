import Foundation

struct KokoroAneVoicePack: Sendable {

    let storage: [Float]

    init(storage: [Float]) throws {
        let expected = KokoroAneConstants.voicePackRows * KokoroAneConstants.voicePackCols
        guard storage.count == expected else {
            throw KokoroAneError.invalidVoicePack(
                "expected \(expected) fp32 elements, got \(storage.count)")
        }
        self.storage = storage
    }

    static func load(from url: URL) throws -> KokoroAneVoicePack {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw KokoroAneError.voicePackMissing(url)
        }
        let data = try Data(contentsOf: url)

        if url.pathExtension.lowercased() == "json" {

            guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw KokoroAneError.invalidVoicePack("expected a JSON object of rows")
            }
            let rows = KokoroAneConstants.voicePackRows
            let cols = KokoroAneConstants.voicePackCols
            var storage: [Float] = []
            storage.reserveCapacity(rows * cols)
            for row in 1...rows {
                guard let rowArr = dict[String(row)] as? [Any] else {
                    throw KokoroAneError.invalidVoicePack("missing row \(row)")
                }

                guard rowArr.count == cols else {
                    throw KokoroAneError.invalidVoicePack(
                        "row \(row) has \(rowArr.count) elements, expected \(cols)")
                }
                for value in rowArr {
                    guard let n = value as? NSNumber else {
                        throw KokoroAneError.invalidVoicePack(
                            "row \(row) contains a non-numeric value")
                    }
                    storage.append(n.floatValue)
                }
            }
            return try KokoroAneVoicePack(storage: storage)
        }

        let elemSize = MemoryLayout<Float>.size
        guard data.count % elemSize == 0 else {
            throw KokoroAneError.invalidVoicePack(
                "file size \(data.count) is not a multiple of sizeof(Float)=\(elemSize)")
        }
        let count = data.count / elemSize
        var storage = [Float](repeating: 0, count: count)
        _ = storage.withUnsafeMutableBytes { dst in
            data.copyBytes(to: dst)
        }
        return try KokoroAneVoicePack(storage: storage)
    }

    func slice(for phonemeCount: Int) -> (styleS: [Float], styleTimbre: [Float]) {
        let cols = KokoroAneConstants.voicePackCols
        let row = max(min(phonemeCount - 1, KokoroAneConstants.voicePackRows - 1), 0)
        let base = row * cols
        let timbreRange = base..<(base + 128)
        let styleSRange = (base + 128)..<(base + cols)
        return (
            styleS: Array(storage[styleSRange]),
            styleTimbre: Array(storage[timbreRange])
        )
    }
}
