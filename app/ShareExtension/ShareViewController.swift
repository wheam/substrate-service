import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// 分享扩展入口：取出 URL / 文本，套一层 SwiftUI 撰写面板。
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        Task { await loadSharedContent() }
    }

    private func loadSharedContent() async {
        var sharedURL: String?
        var sharedText: String?

        let attachments = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []
        for provider in attachments {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier),
               let url = item as? URL {
                sharedURL = url.absoluteString
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) {
                sharedText = (item as? String) ?? (item as? NSAttributedString)?.string
            }
        }

        let content = ShareContent(url: sharedURL, text: sharedText)
        await MainActor.run {
            let host = UIHostingController(rootView: ShareView(
                content: content,
                onDone: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
                onCancel: { [weak self] in
                    self?.extensionContext?.cancelRequest(withError: NSError(domain: "cortex", code: 0))
                }
            ))
            host.view.frame = view.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addChild(host)
            view.addSubview(host.view)
            host.didMove(toParent: self)
        }
    }
}
