import Foundation

struct KokoroAneVocab: Sendable {

    let map: [Character: Int32]

    static func load(from url: URL) throws -> KokoroAneVocab {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw KokoroAneError.vocabMissing(url)
        }
        let data = try Data(contentsOf: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw KokoroAneError.vocabParseFailed(url, "expected top-level JSON object")
        }
        let vocabulary = json["vocab"] as? [String: Any] ?? json
        var parsed: [Character: Int32] = [:]
        parsed.reserveCapacity(vocabulary.count)
        for (key, value) in vocabulary {
            guard let ch = key.first, key.count == 1 else { continue }
            if let intValue = value as? Int {
                parsed[ch] = Int32(intValue)
            }
        }
        return KokoroAneVocab(map: parsed)
    }

    func encode(_ phonemes: String) throws -> [Int32] {
        if phonemes.count > KokoroAneConstants.maxPhonemeLength {
            throw KokoroAneError.phonemeSequenceTooLong(phonemes.count)
        }
        var ids: [Int32] = []
        ids.reserveCapacity(phonemes.count + 2)
        ids.append(KokoroAneConstants.bosTokenId)
        for ch in phonemes {
            if let id = map[ch] {
                ids.append(id)
            }
        }
        ids.append(KokoroAneConstants.eosTokenId)
        return ids
    }
}
