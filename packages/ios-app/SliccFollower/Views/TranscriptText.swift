import SwiftUI
import UIKit

// MARK: - Style

/// Everything the UIKit text view needs to paint one inline run the way the
/// SwiftUI transcript already paints it. Passed as a value so the view stays
/// `Equatable` and a scroll does not rebuild an attributed string per frame.
struct TranscriptTextStyle: Equatable {
    var fontSize: CGFloat = 15
    var weight: UIFont.Weight = .regular
    var italic = false
    var ink: UIColor = .label
    /// Links the user can follow — the accent the SwiftUI `.tint` supplies.
    var accent: UIColor = .tintColor
    var codeForeground: UIColor = .tintColor
    var codeBackground: UIColor = UIColor.label.withAlphaComponent(0.10)
    var codeFontSize: CGFloat = 14
    /// Whether a `slicc-transcript://code` run is painted as a link. It never
    /// is: pre-formatted text already reads as a distinct thing, and tinting
    /// it accent would claim it navigates somewhere.
    var underlineLinks = false
}

// MARK: - Attributed string bridging

/// Turning the transcript's semantic `AttributedString` into something UIKit
/// can render.
///
/// SwiftUI's `Text` interprets `inlinePresentationIntent` itself — a run
/// tagged `.stronglyEmphasized` comes out bold with no font ever being set.
/// TextKit does not: it renders the `.font` attribute and nothing else, so a
/// converted string loses every bold, italic and code run unless the intents
/// are MATERIALISED into real fonts first. That is what this does, and it is
/// why the UIKit path needs its own styling pass rather than reusing
/// `styledInlineCode`.
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
            // A code run keeps its code colours: the action it carries is Copy,
            // not navigation, so painting it accent would be a lie.
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

// MARK: - Accessibility

/// A `UITextView` that keeps the accessibility shape a SwiftUI `Text` had.
///
/// Swapping the text engine under the transcript changes what assistive
/// technology — and anything else driving the app through accessibility —
/// sees, in two ways that this feature never set out to change:
///
/// - a non-editable text view publishes its contents as the accessibility
///   VALUE and leaves the LABEL empty, where `Text` does the opposite, so
///   every announcement is re-worded ("<empty>, value: I wrote it to…") and
///   every lookup by label stops matching;
/// - it reports the `textView` element type rather than `staticText`, so it
///   drops out of a static-text query entirely — which is how it silently
///   broke UI tests with nothing to do with short actions.
///
/// A settled chat message IS static text: non-editable, non-scrolling prose.
/// So it says so, and puts the label back. Value is suppressed rather than
/// duplicated — VoiceOver reads label THEN value, so reporting both would
/// speak the paragraph twice.
final class TranscriptTextView: UITextView {
    /// Asserted here rather than once at construction: `UITextView` recomputes
    /// its own traits when its text changes, which would drop `.staticText`
    /// on the next streaming chunk.
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

// MARK: - TranscriptText

/// The transcript's inline text, rendered by TextKit so a link can carry a
/// LONG PRESS as well as a tap.
///
/// SwiftUI's `Text` renders `.link` runs and routes a tap through
/// `\.openURL`, and that is the whole of its link API: there is no per-span
/// gesture, no preview, no menu. Every short action the transcript owes a
/// reader on a phone — share this number, copy this snippet, open this URL
/// somewhere else — is a SECOND action on a span that already has a default
/// one, and `UITextView` is the only text engine on the platform that models
/// that (`primaryActionFor` / `menuConfigurationFor`, iOS 17+).
///
/// So prose, list items and blockquotes go through here. Headings and table
/// cells stay on SwiftUI `Text`: they carry the same links and the same tap
/// behaviour, they just have no long-press menu — a deliberate, documented
/// gap, because those two call sites are laid out by `MarkdownTableLayout`
/// against measured `Text` metrics and swapping the engine underneath them
/// would move every column.
///
/// Two things keep it off the transcript's hot path. `isScrollEnabled` is
/// false, so the text view adds no pan recogniser of its own and a horizontal
/// drag over a paragraph still reaches the scoop swipe. And the coordinator
/// remembers the last run it rendered, so `updateUIView` reassigns — and
/// TextKit re-lays out — only when the content actually changed.
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
        // Empty rather than a colour: every link run already carries its own
        // foreground, and `linkTextAttributes` would override all of them with
        // one tint — repainting inline code as a hyperlink.
        view.linkTextAttributes = [:]
        view.adjustsFontForContentSizeCategory = false
        // One element, like the `Text` this replaced — see `TranscriptTextView`.
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
        // A transcript row is updated on every body evaluation, unchanged or
        // not — measured at 871 evaluations to scroll back two screens. Both
        // steps below are expensive enough to matter at that rate: building
        // the `NSAttributedString` walks every run, and assigning it makes
        // TextKit re-lay-out the whole paragraph. The coordinator remembers
        // its last input so an unchanged row does neither.
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

    // MARK: - Coordinator

    final class Coordinator: NSObject, UITextViewDelegate {
        private var actions = TranscriptActionHandlers()
        private var openURL: OpenURLAction?
        private var openLinksInBuiltInBrowser = true
        private var rendered: (attributed: AttributedString, style: TranscriptTextStyle)?

        /// The `NSAttributedString` for this run, or `nil` when the view
        /// already shows it.
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

        /// The TAP. Everything goes back out through `\.openURL`, which
        /// `ChatView.transcriptLinkAction` owns: one routing rule for the
        /// UIKit path and the SwiftUI one, so a link cannot behave differently
        /// depending on which block it landed in.
        func textView(
            _ textView: UITextView, primaryActionFor textItem: UITextItem,
            defaultAction: UIAction
        ) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { [weak self] _ in self?.openURL?(url) }
        }

        /// The LONG PRESS.
        ///
        /// Only the ACTIONS are ours. UIKit still supplies its own preview
        /// above the menu for a web URL, which is the platform behaviour a
        /// reader expects; a `slicc-transcript://` URL has nothing to preview
        /// and correctly gets none.
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
                // The URL itself, not its text: a share sheet handed a `URL`
                // offers Safari, Reading List and the rest, where a string of
                // the same characters only offers Copy.
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
