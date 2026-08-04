import CoreGraphics

/// Decides whether a completed transcript drag navigates between scoops.
struct SwipeArbiter {
    enum Action: Equatable {
        case next
        case previous
        case none
    }

    struct ScrollContext: Equatable {
        let atLeadingEdge: Bool
        let atTrailingEdge: Bool

        init(atLeadingEdge: Bool, atTrailingEdge: Bool) {
            self.atLeadingEdge = atLeadingEdge
            self.atTrailingEdge = atTrailingEdge
        }

        init(
            offset: CGFloat,
            contentWidth: CGFloat,
            viewportWidth: CGFloat,
            tolerance: CGFloat = 1
        ) {
            guard contentWidth > 0, viewportWidth > 0 else {
                atLeadingEdge = false
                atTrailingEdge = false
                return
            }
            let maximumOffset = max(contentWidth - viewportWidth, 0)
            if maximumOffset <= tolerance {
                atLeadingEdge = true
                atTrailingEdge = true
            } else {
                atLeadingEdge = offset <= tolerance
                atTrailingEdge = offset >= maximumOffset - tolerance
            }
        }
    }

    enum DragOrigin: Equatable {
        case ordinaryContent
        case guardedContent(ScrollContext)
        case unknown
    }

    static let gestureMinimumDistance: CGFloat = 40
    private static let actionThreshold: CGFloat = 60
    private static let horizontalDominance: CGFloat = 1.5

    static func action(
        for translation: CGSize,
        origin: DragOrigin
    ) -> Action {
        let horizontal = translation.width
        let vertical = translation.height
        guard abs(horizontal) > actionThreshold,
            abs(horizontal) > abs(vertical) * horizontalDominance
        else { return .none }

        guard origin != .unknown else { return .none }
        guard case .guardedContent(let scrollContext) = origin else {
            return horizontal < 0 ? .next : .previous
        }

        if horizontal < 0 {
            guard scrollContext.atTrailingEdge else { return .none }
            return .next
        }
        guard scrollContext.atLeadingEdge else { return .none }
        return .previous
    }

}
