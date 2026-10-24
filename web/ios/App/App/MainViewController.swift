import UIKit
import WebKit
import Capacitor

/// The app's one screen: Capacitor's web view, holding the bundled web app, below the status bar.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OffbookedNativePlugin())
        keepWebViewBelowStatusBar()
    }

    /// The web app pins its headers to the top of the page. Rather than teach every sticky header
    /// about the notch, the web view starts under the status bar and runs to the bottom edge, where
    /// the page already pads for the home indicator (env(safe-area-inset-bottom)).
    private func keepWebViewBelowStatusBar() {
        guard let webView = webView else { return }
        let container = UIView()
        container.backgroundColor = .white
        view = container
        container.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .darkContent
    }
}
