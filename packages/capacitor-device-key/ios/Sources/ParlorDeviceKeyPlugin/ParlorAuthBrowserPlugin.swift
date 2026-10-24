import AuthenticationServices
import Capacitor
import Foundation

@objc(ParlorAuthBrowserPlugin)
public class ParlorAuthBrowserPlugin: CAPPlugin, CAPBridgedPlugin,
    ASWebAuthenticationPresentationContextProviding
{
    public let identifier = "ParlorAuthBrowserPlugin"
    public let jsName = "ParlorAuthBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    private var session: ASWebAuthenticationSession?

    @objc func open(_ call: CAPPluginCall) {
        guard let address = call.getString("url"), let url = URL(string: address),
            url.scheme == "https" || url.scheme == "http",
            let scheme = call.getString("callbackScheme"), !scheme.isEmpty
        else {
            call.reject("An http(s) url and a callbackScheme are required.")
            return
        }
        DispatchQueue.main.async {
            self.session?.cancel()
            var running: ASWebAuthenticationSession?
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) {
                [weak self] callback, error in
                if let self, self.session === running { self.session = nil }
                running = nil
                if let callback {
                    call.resolve(["url": callback.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError,
                    error.code == .canceledLogin
                {
                    call.resolve([:])
                } else {
                    call.reject(error?.localizedDescription ?? "Sign-in did not finish.")
                }
            }
            session.presentationContextProvider = self
            running = session
            self.session = session
            if !session.start() {
                self.session = nil
                running = nil
                call.reject("The sign-in browser could not open.")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession)
        -> ASPresentationAnchor
    {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }
}
