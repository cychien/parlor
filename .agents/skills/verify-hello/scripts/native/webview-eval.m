// Loaded into a Mac shell app with DYLD_INSERT_LIBRARIES by hello.mjs: answers one JSON line
// {"js": BODY} per connection on the Unix socket PARLOR_VERIFY_WEBVIEW_SOCKET with
// {"ok": true, "result": STRING} after running BODY with callAsyncJavaScript in the page world
// of the app's first WKWebView, the way Web Inspector's console would.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static WKWebView *findWebView(NSView *view) {
  if ([view isKindOfClass:[WKWebView class]]) return (WKWebView *)view;
  for (NSView *child in view.subviews) {
    WKWebView *found = findWebView(child);
    if (found) return found;
  }
  return nil;
}

static NSData *reply(NSDictionary *object) {
  NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:object options:0 error:nil] mutableCopy];
  [data appendBytes:"\n" length:1];
  return data;
}

static NSData *evaluate(NSString *body) {
  __block NSData *out = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{
    WKWebView *webView = nil;
    for (NSWindow *window in NSApp.windows) {
      webView = findWebView(window.contentView);
      if (webView) break;
    }
    if (!webView) {
      out = reply(@{@"ok" : @NO, @"error" : @"no WKWebView in the app's windows"});
      dispatch_semaphore_signal(done);
      return;
    }
    [webView callAsyncJavaScript:body
                       arguments:@{}
                         inFrame:nil
                  inContentWorld:WKContentWorld.pageWorld
               completionHandler:^(id result, NSError *error) {
                 if (error) {
                   NSString *message = error.userInfo[@"WKJavaScriptExceptionMessage"] ?: error.localizedDescription;
                   out = reply(@{@"ok" : @NO, @"error" : message ?: @"evaluation failed"});
                 } else if ([result isKindOfClass:[NSString class]]) {
                   out = reply(@{@"ok" : @YES, @"result" : result});
                 } else {
                   out = reply(@{@"ok" : @NO, @"error" : @"the body must return a string"});
                 }
                 dispatch_semaphore_signal(done);
               }];
  });
  CFRunLoopWakeUp(CFRunLoopGetMain());
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC)) != 0)
    return reply(@{@"ok" : @NO, @"error" : @"timed out after 120 s"});
  return out;
}

static void serve(NSString *path) {
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  strlcpy(address.sun_path, path.fileSystemRepresentation, sizeof(address.sun_path));
  unlink(address.sun_path);
  if (bind(server, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(server, 8) != 0) return;
  chmod(address.sun_path, 0600);
  for (;;) {
    int client = accept(server, NULL, NULL);
    if (client < 0) continue;
    NSMutableData *input = [NSMutableData data];
    char buffer[65536];
    ssize_t count;
    while ((count = read(client, buffer, sizeof(buffer))) > 0) {
      [input appendBytes:buffer length:count];
      if (memchr(buffer, '\n', count)) break;
    }
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    NSData *out = [request[@"js"] isKindOfClass:[NSString class]]
                      ? evaluate(request[@"js"])
                      : reply(@{@"ok" : @NO, @"error" : @"expected {\"js\": string}"});
    const char *bytes = out.bytes;
    size_t left = out.length;
    while (left > 0) {
      ssize_t written = write(client, bytes, left);
      if (written <= 0) break;
      bytes += written;
      left -= written;
    }
    close(client);
  }
}

__attribute__((constructor)) static void start(void) {
  const char *socketPath = getenv("PARLOR_VERIFY_WEBVIEW_SOCKET");
  unsetenv("DYLD_INSERT_LIBRARIES");
  if (!socketPath) return;
  NSString *path = @(socketPath);
  unsetenv("PARLOR_VERIFY_WEBVIEW_SOCKET");
  [NSThread detachNewThreadWithBlock:^{
    serve(path);
  }];
}
