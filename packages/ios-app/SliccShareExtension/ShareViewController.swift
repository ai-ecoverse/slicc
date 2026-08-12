import UIKit
import UniformTypeIdentifiers

/// Safari's "Sliccy" share row (#1918): ChatGPT-style instant handoff. The
/// panel appears just long enough to validate the URL, park it in the App
/// Group inbox, and open the containing app through the responder chain's
/// `UIApplication` — the pattern ChatGPT, Claude, Grok, and Bluesky
/// (github.com/bluesky-social/social-app) ship through App Review.
/// `extensionContext.open` is not honored in Share extensions (verified on
/// device; Apple forums #773342), so the chain walk is the only working
/// route. If it ever stops working, the inbox is the source of truth and
/// the panel says so honestly instead of pretending.
///
/// The in-app confirmation card still gates what actually opens; per-host
/// "Always" decisions apply there. Deep link + inbox double delivery is
/// absorbed by the coordinator's replay dedup.
final class ShareViewController: UIViewController {

    private let statusLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        statusLabel.font = .preferredFont(forTextStyle: .callout)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.text = "Opening Sliccy…"
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusLabel.leadingAnchor.constraint(
                greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        handleAttachment()
    }

    private func handleAttachment() {
        let providers =
            (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []
        guard
            let provider = providers.first(where: {
                $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
            })
        else {
            finish(message: "Nothing Sliccy can open here.")
            return
        }
        provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let url = item as? URL, Self.isWebURL(url) else {
                    self.finish(message: "Nothing Sliccy can open here.")
                    return
                }
                self.handOff(url: url)
            }
        }
    }

    private func handOff(url: URL) {
        // Inbox first — the request survives even if the open is refused.
        _ = AppGroupInbox().enqueue(url: url)
        guard
            let encoded = url.absoluteString.addingPercentEncoding(
                withAllowedCharacters: .alphanumerics),
            let bounce = URL(string: "slicc://open?url=\(encoded)"),
            openViaResponderChain(bounce)
        else {
            finish(message: "Sent to Sliccy — open the app to continue.")
            return
        }
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// Bluesky's shipped mechanism: the responder chain ends at the live
    /// `UIApplication`, whose instance `open` the extension may call once
    /// the target drops APPLICATION_EXTENSION_API_ONLY.
    private func openViaResponderChain(_ url: URL) -> Bool {
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication {
                application.open(url, options: [:], completionHandler: nil)
                return true
            }
            responder = current.next
        }
        return false
    }

    private func finish(message: String) {
        statusLabel.text = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    /// The extension repeats the app-side validation rather than trusting
    /// the activation rule: http(s) only, no credentials, bounded.
    static func isWebURL(_ url: URL) -> Bool {
        guard url.absoluteString.count <= 2048,
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            components.user == nil, components.password == nil,
            let host = components.host, !host.isEmpty
        else { return false }
        return true
    }
}
