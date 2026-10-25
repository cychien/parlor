use tauri::{Url, WebviewWindow};

fn sign_in_page(url: &str) -> Result<Url, String> {
    match Url::parse(url) {
        Ok(page) if matches!(page.scheme(), "https" | "http") => Ok(page),
        _ => Err(format!("The sign-in page must be an http(s) URL: {url:?}")),
    }
}

fn url_scheme(scheme: &str) -> Result<&str, String> {
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+.-".contains(c));
    if valid {
        Ok(scheme)
    } else {
        Err(format!("The callback must be the app's URL scheme: {scheme:?}"))
    }
}

#[cfg(target_os = "macos")]
mod apple {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::NSWindow;
    use objc2_authentication_services::{
        ASWebAuthenticationPresentationContextProviding, ASWebAuthenticationSession,
        ASWebAuthenticationSessionErrorCode, ASWebAuthenticationSessionErrorDomain,
    };
    use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString, NSURL};
    use tauri::{Url, WebviewWindow};

    type Outcome = Result<Option<String>, String>;
    /// The session presents over its anchor, which it holds weakly.
    type Running = (Retained<ASWebAuthenticationSession>, Retained<Anchor>);

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Retained<NSWindow>]
        struct Anchor;

        unsafe impl NSObjectProtocol for Anchor {}

        unsafe impl ASWebAuthenticationPresentationContextProviding for Anchor {
            #[unsafe(method_id(presentationAnchorForWebAuthenticationSession:))]
            fn anchor(&self, _session: &ASWebAuthenticationSession) -> Retained<NSWindow> {
                self.ivars().clone()
            }
        }
    );

    impl Anchor {
        fn new(mtm: MainThreadMarker, window: Retained<NSWindow>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(window);
            unsafe { msg_send![super(this), init] }
        }
    }

    fn outcome(url: *mut NSURL, error: *mut NSError) -> Outcome {
        if let Some(url) = unsafe { url.as_ref() } {
            return Ok(url.absoluteString().map(|text| text.to_string()));
        }
        let Some(error) = (unsafe { error.as_ref() }) else {
            return Err("Sign-in did not finish.".to_string());
        };
        let cancelled = error.domain().to_string()
            == unsafe { ASWebAuthenticationSessionErrorDomain }.to_string()
            && error.code() == ASWebAuthenticationSessionErrorCode::CanceledLogin.0;
        if cancelled {
            Ok(None)
        } else {
            Err(error.localizedDescription().to_string())
        }
    }

    /// Runs on the main thread; the session and its anchor stay alive until it completes.
    fn start(window: &WebviewWindow, page: &Url, scheme: &str, done: mpsc::Sender<Outcome>) {
        let fail = |done: &mpsc::Sender<Outcome>, message: &str| {
            let _ = done.send(Err(message.to_string()));
        };
        let Some(mtm) = MainThreadMarker::new() else {
            return fail(&done, "The sign-in browser must open on the main thread.");
        };
        let Some(ns_window) = window
            .ns_window()
            .ok()
            .and_then(|pointer| unsafe { Retained::retain(pointer.cast::<NSWindow>()) })
        else {
            return fail(&done, "The app has no window to show the sign-in browser over.");
        };
        let Some(url) = NSURL::URLWithString(&NSString::from_str(page.as_str())) else {
            return fail(&done, "The sign-in page URL is not valid.");
        };
        let anchor = Anchor::new(mtm, ns_window);
        let running: Rc<RefCell<Option<Running>>> = Rc::new(RefCell::new(None));
        let keep = running.clone();
        let reply = RefCell::new(Some(done.clone()));
        let completion = RcBlock::new(move |url: *mut NSURL, error: *mut NSError| {
            keep.borrow_mut().take();
            if let Some(done) = reply.borrow_mut().take() {
                let _ = done.send(outcome(url, error));
            }
        });
        #[allow(deprecated)]
        let session = unsafe {
            ASWebAuthenticationSession::initWithURL_callbackURLScheme_completionHandler(
                ASWebAuthenticationSession::alloc(),
                &url,
                Some(&NSString::from_str(scheme)),
                RcBlock::as_ptr(&completion),
            )
        };
        unsafe {
            session.setPresentationContextProvider(Some(ProtocolObject::from_ref(&*anchor)));
            session.setPrefersEphemeralWebBrowserSession(false);
        }
        *running.borrow_mut() = Some((session.clone(), anchor));
        if !unsafe { session.start() } {
            running.borrow_mut().take();
            fail(&done, "The sign-in browser could not open.");
        }
    }

    pub async fn open(window: WebviewWindow, page: Url, scheme: String) -> Outcome {
        let (done, outcome) = mpsc::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || start(&target, &page, &scheme, done))
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || outcome.recv())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "The sign-in browser closed without an answer.".to_string())?
    }
}

#[cfg(not(target_os = "macos"))]
mod apple {
    use tauri::{Url, WebviewWindow};

    pub async fn open(
        _window: WebviewWindow,
        _page: Url,
        _scheme: String,
    ) -> Result<Option<String>, String> {
        Err("unsupported".to_string())
    }
}

/// Opens `url` in ASWebAuthenticationSession and resolves with the URL it returned to under
/// `callback_scheme`, or `None` when the user closed it.
#[tauri::command]
pub async fn parlor_auth_browser_open(
    window: WebviewWindow,
    url: String,
    callback_scheme: String,
) -> Result<Option<String>, String> {
    let page = sign_in_page(&url)?;
    let scheme = url_scheme(&callback_scheme)?.to_string();
    apple::open(window, page, scheme).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_http_page_and_a_url_scheme_are_accepted() {
        assert!(sign_in_page("https://app.example.com/_parlor/auth/native").is_ok());
        assert!(sign_in_page("http://localhost:3000/x").is_ok());
        for bad in ["", "javascript:alert(1)", "file:///etc/passwd", "hello://x"] {
            assert!(sign_in_page(bad).is_err(), "{bad}");
        }
        assert_eq!(url_scheme("hello"), Ok("hello"));
        assert_eq!(url_scheme("dev.parlor-app+x"), Ok("dev.parlor-app+x"));
        for bad in ["", "Hello", "1app", "a b", "https://x"] {
            assert!(url_scheme(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_refused_probe_never_reads_as_unavailable() {
        for error in [sign_in_page("").unwrap_err(), url_scheme("").unwrap_err()] {
            let lower = error.to_lowercase();
            assert!(!lower.contains("not found") && !lower.contains("unsupported"));
        }
    }
}
