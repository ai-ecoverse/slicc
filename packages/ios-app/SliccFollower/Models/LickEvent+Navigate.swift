import Foundation
import SliccTrayKit

extension LickEvent {
    
    
    
    static func navigate(
        pageURL: String,
        match: HandoffMatch,
        title: String? = nil,
        timestamp: String = ISO8601DateFormatter().string(from: Date())
    ) -> LickEvent {
        
        
        var body: [String: Any] = [
            "url": pageURL,
            "verb": match.verb.rawValue,
            "target": match.target,
        ]
        if let instruction = match.instruction { body["instruction"] = instruction }
        if let branch = match.branch { body["branch"] = branch }
        if let path = match.path { body["path"] = path }
        if let title, !title.isEmpty { body["title"] = title }
        return LickEvent(
            type: .navigate,
            timestamp: timestamp,
            body: AnyCodable(body),
            navigateUrl: pageURL)
    }
}
