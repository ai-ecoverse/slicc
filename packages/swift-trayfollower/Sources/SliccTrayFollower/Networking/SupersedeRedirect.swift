import Foundation
















public enum SupersedeRedirect {
    public static let maxRedirects = 5
    public static let delaySeconds: TimeInterval = 1.0

    public enum Outcome: Equatable {
        
        case terminal
        
        case follow(URL)
        
        case exhausted
        
        case invalidJoinUrl
    }

    
    
    
    
    
    
    
    
    public static func outcome(
        for plan: FollowerAttachPlan, redirectsFollowed: Int
    ) -> Outcome {
        guard let raw = plan.supersededByJoinUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
        else { return .terminal }

        guard redirectsFollowed < maxRedirects else { return .exhausted }
        
        
        
        guard let url = URL(string: raw), url.scheme != nil, url.host != nil else {
            return .invalidJoinUrl
        }
        return .follow(url)
    }

    
    
    public static func failureMessage(for outcome: Outcome) -> String? {
        switch outcome {
        case .exhausted:
            return
                "This session moved \(maxRedirects) times without settling "
                + "(possible redirect loop)."
        case .invalidJoinUrl:
            return "This session moved, but the replacement address was unusable."
        case .terminal, .follow:
            return nil
        }
    }
}
