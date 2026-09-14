import SwiftUI
import UIKit






struct TranscriptTextStyle: Equatable {
    var fontSize: CGFloat = 15
    var weight: UIFont.Weight = .regular
    var italic = false
    var ink: UIColor = .label
    
    var accent: UIColor = .tintColor
    var codeForeground: UIColor = .tintColor
    var codeBackground: UIColor = UIColor.label.withAlphaComponent(0.10)
    var codeFontSize: CGFloat = 14
    
    
    
    var underlineLinks = false
}













enum TranscriptAttributedText {

    static func nsAttributedString(_ input: AttributedString, style: TranscriptTextStyle)
        -> NSAttributedString
    {
        let output = NSMutableAttributedString()
        for run in input.runs {
            let slice = String(input[run.range].characters)
            guard !slice.isEmpty else { continue }
            output.append(
                NSAttributedString(string: slice, attributes: attributes(for: run, style: style)))
        }
        return output
    }

    private static func attributes(
        for run: AttributedString.Runs.Run, style: TranscriptTextStyle
    ) -> [NSAttributedString.Key: Any] {
        let intent = run.inlinePresentationIntent ?? []
        let isCode = intent.contains(.code)
        var attributes: [NSAttributedString.Key: Any] = [:]

        attributes[.font] = font(intent: intent, isCode: isCode, style: style)
        attributes[.foregroundColor] = isCode ? style.codeForeground : style.ink
        if isCode { attributes[.backgroundColor] = style.codeBackground }
        if intent.contains(.strikethrough) {
            attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }

        if let link = run.link {
            attributes[.link] = link
            
            
            if !isCode {
                attributes[.foregroundColor] = style.accent
                if style.underlineLinks {
                    attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                }
            }
        }
        return attributes
    }

    private static func font(
        intent: InlinePresentationIntent, isCode: Bool, style: TranscriptTextStyle
    ) -> UIFont {
        if isCode {
            return UIFont.monospacedSystemFont(ofSize: style.codeFontSize, weight: .regular)
        }
        let bold = intent.contains(.stronglyEmphasized)
        let italic = style.italic || intent.contains(.emphasized)
        let base = UIFont.systemFont(
            ofSize: style.fontSize, weight: bold ? .semibold : style.weight)
        guard italic else { return base }
        guard let descriptor = base.fontDescriptor.withSymbolicTraits(.traitItalic) else {
            return base
        }
        return UIFont(descriptor: descriptor, size: style.fontSize)
    }
}





















final class TranscriptTextView: UITextView {
    
    
    
    override var accessibilityTraits: UIAccessibilityTraits {
        get { .staticText }
        set { super.accessibilityTraits = newValue }
    }

    override var accessibilityLabel: String? {
        get { text }
        set { super.accessibilityLabel = newValue }
    }

    override var accessibilityValue: String? {
        get { nil }
        set { super.accessibilityValue = newValue }
    }
}


























struct TranscriptText: UIViewRepresentable {
    let attributed: AttributedString
    var style = TranscriptTextStyle()
    var alignment: NSTextAlignment = .natural

    @Environment(\.openURL) private var openURL
    @Environment(\.transcriptActions) private var actions
    @AppStorage("openLinksInBuiltInBrowser") private var openLinksInBuiltInBrowser = true

    func makeUIView(context: Context) -> UITextView {
        let view = TranscriptTextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        
        
        
        view.linkTextAttributes = [:]
        view.adjustsFontForContentSizeCategory = false
        
        view.isAccessibilityElement = true
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.required, for: .vertical)
        view.setContentHuggingPriority(.required, for: .vertical)
        view.textContainer.lineBreakMode = .byWordWrapping
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.update(
            actions: actions, openURL: openURL,
            openLinksInBuiltInBrowser: openLinksInBuiltInBrowser)
        
        
        
        
        
        
        guard let next = context.coordinator.attributedText(for: attributed, style: style) else {
            return
        }
        view.attributedText = next
        if view.textAlignment != alignment { view.textAlignment = alignment }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? UIScreen.main.bounds.width
        guard width > 0, width < .greatestFiniteMagnitude else { return nil }
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(size.height))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    

    final class Coordinator: NSObject, UITextViewDelegate {
        private var actions = TranscriptActionHandlers()
        private var openURL: OpenURLAction?
        private var openLinksInBuiltInBrowser = true
        private var rendered: (attributed: AttributedString, style: TranscriptTextStyle)?

        
        
        func attributedText(for attributed: AttributedString, style: TranscriptTextStyle)
            -> NSAttributedString?
        {
            if let rendered, rendered.attributed == attributed, rendered.style == style {
                return nil
            }
            rendered = (attributed, style)
            return TranscriptAttributedText.nsAttributedString(attributed, style: style)
        }

        func update(
            actions: TranscriptActionHandlers, openURL: OpenURLAction,
            openLinksInBuiltInBrowser: Bool
        ) {
            self.actions = actions
            self.openURL = openURL
            self.openLinksInBuiltInBrowser = openLinksInBuiltInBrowser
        }

        
        
        
        
        func textView(
            _ textView: UITextView, primaryActionFor textItem: UITextItem,
            defaultAction: UIAction
        ) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { [weak self] _ in self?.openURL?(url) }
        }

        
        
        
        
        
        
        func textView(
            _ textView: UITextView, menuConfigurationFor textItem: UITextItem,
            defaultMenu: UIMenu
        ) -> UITextItem.MenuConfiguration? {
            guard case .link(let url) = textItem.content else { return nil }
            let children = menuChildren(for: url)
            guard !children.isEmpty else { return nil }
            return UITextItem.MenuConfiguration(menu: UIMenu(children: children))
        }

        private func menuChildren(for url: URL) -> [UIMenuElement] {
            if let link = TranscriptLink.decode(url) { return transcriptMenu(link) }
            return webOrSystemMenu(url)
        }

        private func transcriptMenu(_ link: TranscriptLink) -> [UIMenuElement] {
            switch link {
            case .code(let text):
                return [copy(text), share(text)]
            case .phone(let number):
                var children: [UIMenuElement] = []
                if let sms = link.systemURL {
                    children.append(item("Message", "message") { [weak self] in self?.open(sms) })
                }
                if let tel = telephoneURL(for: number) {
                    children.append(item("Call", "phone") { [weak self] in self?.open(tel) })
                }
                children.append(copy(number))
                children.append(share(number))
                return children
            case .file(let path, let line):
                let preview = item("Preview", "eye") { [weak self] in
                    self?.actions.preview(.leaderFile(path: path, line: line))
                }
                return [preview, copy(path, titled: "Copy Path"), share(path)]
            }
        }

        private func webOrSystemMenu(_ url: URL) -> [UIMenuElement] {
            let scheme = url.scheme?.lowercased()
            let inSliccy = (scheme == "http" || scheme == "https") && openLinksInBuiltInBrowser
            let open =
                inSliccy
                ? item("Open in Sliccy", "globe") { [weak self] in self?.open(url) }
                : item("Open", "arrow.up.forward.app") { [weak self] in self?.open(url) }
            return [
                open,
                copy(url.absoluteString, titled: "Copy Link"),
                
                
                
                share(url.absoluteString, item: url),
            ]
        }

        private func telephoneURL(for number: String) -> URL? {
            let digits = number.filter { $0.isNumber || $0 == "+" }
            return digits.isEmpty ? nil : URL(string: "tel:\(digits)")
        }

        private func open(_ url: URL) { openURL?(url) }

        private func item(_ title: String, _ symbol: String, run: @escaping () -> Void) -> UIAction {
            UIAction(title: title, image: UIImage(systemName: symbol)) { _ in run() }
        }

        private func copy(_ text: String, titled title: String = "Copy") -> UIAction {
            item(title, "doc.on.doc") { TranscriptClipboard.copy(text) }
        }

        private func share(_ text: String, item value: Any? = nil) -> UIAction {
            item("Share…", "square.and.arrow.up") { [weak self] in
                self?.actions.share(TranscriptShareRequest(items: [value ?? text]))
            }
        }
    }
}
