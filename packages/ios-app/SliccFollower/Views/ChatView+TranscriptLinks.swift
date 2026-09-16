import SliccTrayKit
import SwiftUI

extension ChatView {

    static func routesToBuiltInBrowser(_ url: URL, enabled: Bool) -> Bool {
        guard enabled, let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    var transcriptLinkAction: OpenURLAction {
        OpenURLAction { url in
            if let link = TranscriptLink.decode(url) {
                handleTranscriptLink(link)

                return .handled
            }
            guard Self.routesToBuiltInBrowser(url, enabled: openLinksInBuiltInBrowser) else {
                return .systemAction
            }
            openInBuiltInBrowser(url)
            return .handled
        }
    }

    func handleTranscriptLink(_ link: TranscriptLink) {
        switch link {
        case .file(let path, let line):
            transcriptActions.preview = .leaderFile(path: path, line: line)
        case .phone:

            if let sms = link.systemURL { openURL(sms) }
        case .code(let text):

            TranscriptClipboard.copy(text)
        }
    }

    var transcriptActionHandlers: TranscriptActionHandlers {
        TranscriptActionHandlers(
            preview: { [transcriptActions] target in transcriptActions.preview = target },
            share: { [transcriptActions] request in transcriptActions.share = request }
        )
    }

}
