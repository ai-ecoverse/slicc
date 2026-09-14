import UIKit
import UniformTypeIdentifiers














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
