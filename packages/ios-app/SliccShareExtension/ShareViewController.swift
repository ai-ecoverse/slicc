import UIKit
import UniformTypeIdentifiers

/// Safari's "SLICC" share row (#1918). An out-of-process extension cannot
/// foreground the containing app (and must not pretend it did — no
/// responder-chain hacks), so this parks the validated URL in the App
/// Group inbox, says so honestly, and completes. The app surfaces the
/// confirmation card on its next activation.
final class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = .preferredFont(forTextStyle: .callout)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.text = "Sending to SLICC…"
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
        handleAttachments(label: label)
    }

    private func handleAttachments(label: UILabel) {
        let providers =
            (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []
        guard
            let provider = providers.first(where: {
                $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
            })
        else {
            finish(label: label, message: "Nothing SLICC can open here.")
            return
        }
        provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let url = item as? URL, Self.isWebURL(url), AppGroupInbox().enqueue(url: url)
                else {
                    self.finish(label: label, message: "Nothing SLICC can open here.")
                    return
                }
                self.finish(label: label, message: "Sent to SLICC — open the app to continue.")
            }
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

    private func finish(label: UILabel, message: String) {
        label.text = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }
}
