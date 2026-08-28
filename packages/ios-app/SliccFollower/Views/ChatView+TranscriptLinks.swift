import SliccTrayKit
import SwiftUI

// MARK: - Transcript links

/// How a tapped span of transcript reaches the rest of the app.
///
/// Split out of `ChatView` because it is one closed decision — where does this
/// URL go? — and the shell around it is already the longest file in the app.
///
/// The members it reaches are deliberately not `private`: `routesToBuiltInBrowser`
/// and the browser hand-off are the same routing `ChatView` applies to its own
/// inbound opens, and duplicating either would be how the two drift apart.
extension ChatView {

    /// Only web links are ours to keep. `mailto:`, `tel:`, and app schemes
    /// have no meaning in a WKWebView tab, so they stay with the system even
    /// when the setting is on.
    static func routesToBuiltInBrowser(_ url: URL, enabled: Bool) -> Bool {
        guard enabled, let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// Scoped to the conversation subtree so only transcript links are
    /// redirected — the shell's own `openURL` (x-callback bounces) and the
    /// Settings sheet keep the system action.
    ///
    /// One routing rule for both text engines. `TranscriptText` hands its taps
    /// straight back here rather than acting on them, so a link cannot behave
    /// differently depending on which block it landed in.
    var transcriptLinkAction: OpenURLAction {
        OpenURLAction { url in
            if let link = TranscriptLink.decode(url) {
                handleTranscriptLink(link)
                // Never `.systemAction`: `slicc-transcript` is not registered,
                // so a leak would surface as an unopenable-URL alert.
                return .handled
            }
            guard Self.routesToBuiltInBrowser(url, enabled: openLinksInBuiltInBrowser) else {
                return .systemAction
            }
            openInBuiltInBrowser(url)
            return .handled
        }
    }

    /// The default action for a tapped transcript entity. Every one of them
    /// has a second action a long press away — see `TranscriptText`.
    func handleTranscriptLink(_ link: TranscriptLink) {
        switch link {
        case .file(let path, let line):
            transcriptActions.preview = .leaderFile(path: path, line: line)
        case .phone:
            // Messages, not the dialer. `openURL` here is the SHELL's, not
            // this action — routing an `sms:` URL back through the transcript
            // rule would bounce it off `routesToBuiltInBrowser` and land it in
            // the system anyway, one hop later.
            if let sms = link.systemURL { openURL(sms) }
        case .code(let text):
            // Copy. A snippet is the one span with nowhere to navigate to, so
            // the useful default IS the copy — and routing it through a
            // SwiftUI dialog instead put the only non-native-looking menu in
            // the feature on the most-tapped span. Share stays on the long
            // press, alongside every other span's menu.
            TranscriptClipboard.copy(text)
        }
    }

    /// Handlers and the resolver the transcript reaches the shell through.
    /// Values, not an observed object, so `MessageBubble` keeps comparing
    /// equal across a sheet opening.
    var transcriptActionHandlers: TranscriptActionHandlers {
        TranscriptActionHandlers(
            preview: { [transcriptActions] target in transcriptActions.preview = target },
            share: { [transcriptActions] request in transcriptActions.share = request }
        )
    }

}
