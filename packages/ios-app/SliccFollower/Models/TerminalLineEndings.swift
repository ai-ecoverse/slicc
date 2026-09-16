import Foundation

struct TerminalLineEndings {

    private var trailingCarriageReturn = false

    mutating func normalize(_ data: Data) -> Data {

        guard data.contains(0x0A) else {
            if let last = data.last { trailingCarriageReturn = last == 0x0D }
            return data
        }

        var out = Data()
        out.reserveCapacity(data.count + 8)
        for byte in data {
            if byte == 0x0A && !trailingCarriageReturn {
                out.append(0x0D)
            }
            trailingCarriageReturn = byte == 0x0D
            out.append(byte)
        }
        return out
    }

    mutating func reset() {
        trailingCarriageReturn = false
    }
}
