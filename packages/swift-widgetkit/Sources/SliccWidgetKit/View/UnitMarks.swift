import SwiftUI























public enum UnitMark {
    
    static let box: CGFloat = 24
    
    static let strokeWidth: CGFloat = 2
}


public struct ConeMark: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        var path = Path()

        
        path.addArc(
            center: CGPoint(x: 12, y: 7), radius: 5,
            startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)

        
        path.addRoundedRect(in: CGRect(x: 7, y: 7, width: 10, height: 4), cornerSize: CGSize(width: 2, height: 2))

        
        path.move(to: CGPoint(x: 7, y: 11))
        path.addLine(to: CGPoint(x: 11.35, y: 20.05))
        path.addQuadCurve(to: CGPoint(x: 12.65, y: 20.05), control: CGPoint(x: 12, y: 21.4))
        path.addLine(to: CGPoint(x: 17, y: 11))

        return path.scaled(toFit: rect)
    }
}


public struct ScoopMark: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        var path = Path()

        
        path.move(to: CGPoint(x: 12, y: 17))
        path.addCurve(
            to: CGPoint(x: 20, y: 11),
            control1: CGPoint(x: 17, y: 17), control2: CGPoint(x: 20, y: 14.31))
        path.addLine(to: CGPoint(x: 4, y: 11))
        path.addCurve(
            to: CGPoint(x: 12, y: 17),
            control1: CGPoint(x: 4, y: 14.31), control2: CGPoint(x: 7, y: 17))

        
        path.addArc(
            center: CGPoint(x: 12, y: 11), radius: 4.5,
            startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)

        
        path.move(to: CGPoint(x: 12, y: 17))
        path.addLine(to: CGPoint(x: 12, y: 21))
        path.move(to: CGPoint(x: 8, y: 21))
        path.addLine(to: CGPoint(x: 16, y: 21))

        return path.scaled(toFit: rect)
    }
}

extension Path {
    
    
    func scaled(toFit rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / UnitMark.box
        let dx = rect.minX + (rect.width - UnitMark.box * scale) / 2
        let dy = rect.minY + (rect.height - UnitMark.box * scale) / 2
        return applying(
            CGAffineTransform(scaleX: scale, y: scale).concatenating(
                CGAffineTransform(translationX: dx, y: dy)))
    }
}



public struct UnitMarkView: View {
    public let role: WidgetUnit.Role
    public var size: CGFloat

    public init(role: WidgetUnit.Role, size: CGFloat = 16) {
        self.role = role
        self.size = size
    }

    public var body: some View {
        mark
            .stroke(
                style: StrokeStyle(
                    lineWidth: UnitMark.strokeWidth * size / UnitMark.box,
                    lineCap: .round, lineJoin: .round)
            )
            
            
            
            .padding(UnitMark.strokeWidth * size / (UnitMark.box * 2))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    
    
    private var mark: AnyShape {
        switch role {
        case .cone: AnyShape(ConeMark())
        case .scoop: AnyShape(ScoopMark())
        }
    }
}
