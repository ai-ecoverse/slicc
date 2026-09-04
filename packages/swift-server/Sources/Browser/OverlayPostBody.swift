import Foundation

// POST-body recovery for the overlay CSP-strip Fetch proxy. Mirrors
// `decodeCdpRequestPostBody` in node-server's `electron-controller.ts` so both
// floats forward the same bytes for the same intercepted request (#2886).

/// Outcome of reconstructing an intercepted request's POST body from the CDP
/// `Fetch.requestPaused` payload.
///
/// - `none`: the request has no body (a GET/HEAD navigation).
/// - `bytes`: the exact body bytes, recovered losslessly.
/// - `unrecoverable`: the request HAS a body but CDP did not hand us its bytes.
///   The caller must fail the request; forwarding a guess would silently corrupt
///   the origin's copy of the upload.
enum OverlayPostBody: Equatable {
    case none
    case bytes(Data)
    case unrecoverable(String)
}

/// Recover the byte-exact POST body of an intercepted `Fetch.requestPaused`
/// request. A document POST is a byte pipe: multipart boundaries wrapping a
/// JPEG are not UTF-8, so `postData.data(using: .utf8)` expands every byte
/// ≥0x80 (`80` → `C2 80`) — and a `Data(base64Encoded:)` first-guess decodes a
/// latin1 body that happens to look like base64 into something else entirely.
///
/// Order of trust (identical to node-server's `decodeCdpRequestPostBody`):
/// 1. `postDataEntries[].bytes` — base64 over the wire, so byte-exact for any
///    body. This is the CDP-recommended source (`postData` is deprecated).
/// 2. `postData` **only when it is pure ASCII** — then UTF-8, latin1 and the raw
///    bytes all coincide, so the string cannot be lossy. Covers the ordinary
///    `application/x-www-form-urlencoded` form post, which percent-encodes.
/// 3. Anything else (a file/blob entry Chrome never exposes, `hasPostData` with
///    the body dropped for length, or a non-ASCII `postData` string with no
///    entries) is unrecoverable. We fail rather than substitute bytes.
func decodeCdpRequestPostBody(request: [String: Any]) -> OverlayPostBody {
    if let entries = request["postDataEntries"] as? [[String: Any]], !entries.isEmpty {
        var body = Data()
        for entry in entries {
            guard let base64 = entry["bytes"] as? String,
                let decoded = Data(base64Encoded: base64)
            else {
                return .unrecoverable("postDataEntries contains a file/blob element with no bytes")
            }
            body.append(decoded)
        }
        return .bytes(body)
    }

    if let postData = request["postData"] as? String, !postData.isEmpty {
        // ASCII: UTF-8, latin1 and the raw bytes all agree, so no codec can lose.
        if postData.unicodeScalars.allSatisfy({ $0.value <= 0x7f }) {
            return .bytes(Data(postData.utf8))
        }
        return .unrecoverable("postData is not pure ASCII and no postDataEntries were provided")
    }

    if request["hasPostData"] as? Bool == true {
        return .unrecoverable("hasPostData is set but CDP provided no body")
    }
    return .none
}

extension OverlayPostBody {
    /// The bytes to forward upstream, or `nil` when the request carries no body.
    /// `.unrecoverable` also yields `nil`; callers must reject that case BEFORE
    /// reading this, or they would silently downgrade a corrupt upload to an
    /// empty one.
    var forwardableBytes: Data? {
        if case .bytes(let data) = self { return data }
        return nil
    }
}
