import Foundation













enum OverlayPostBody: Equatable {
    case none
    case bytes(Data)
    case unrecoverable(String)
}
















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
    
    
    
    
    var forwardableBytes: Data? {
        if case .bytes(let data) = self { return data }
        return nil
    }
}
