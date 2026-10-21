// Accessibility access to a macOS app's windows, for the webview command of hello.mjs.
//   webview-ax trusted
//   webview-ax tree PID                 every window (sheets and dialogs included) as JSON
//   webview-ax press PID PATH           AXPress on the element at PATH ("0.3.1")
//   webview-ax focus PID PATH
//   webview-ax setvalue PID PATH TEXT
//   webview-ax type PID TEXT [DELAY_MS] keystrokes posted to the process
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

static const int kMaxDepth = 90;
static const int kMaxNodes = 12000;
static int nodeCount = 0;

static id attribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return nil;
  return CFBridgingRelease(value);
}

static NSString *stringOf(id value) {
  if (!value) return nil;
  if ([value isKindOfClass:[NSString class]]) return value;
  if ([value isKindOfClass:[NSNumber class]]) return [value stringValue];
  if ([value isKindOfClass:[NSAttributedString class]]) return [value string];
  return nil;
}

static NSArray *childrenOf(AXUIElementRef element) {
  id children = attribute(element, kAXChildrenAttribute);
  return [children isKindOfClass:[NSArray class]] ? children : @[];
}

static NSDictionary *frameOf(AXUIElementRef element) {
  id position = attribute(element, kAXPositionAttribute);
  id size = attribute(element, kAXSizeAttribute);
  CGPoint p = CGPointZero;
  CGSize s = CGSizeZero;
  if (!position || !size) return nil;
  AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &p);
  AXValueGetValue((__bridge AXValueRef)size, kAXValueTypeCGSize, &s);
  return @{@"x" : @(p.x), @"y" : @(p.y), @"w" : @(s.width), @"h" : @(s.height)};
}

static NSDictionary *describe(AXUIElementRef element, NSArray *path, int depth) {
  nodeCount++;
  NSMutableDictionary *node = [NSMutableDictionary dictionary];
  node[@"path"] = [path componentsJoinedByString:@"."];
  NSDictionary *names = @{
    @"role" : (__bridge NSString *)kAXRoleAttribute,
    @"subrole" : (__bridge NSString *)kAXSubroleAttribute,
    @"title" : (__bridge NSString *)kAXTitleAttribute,
    @"desc" : (__bridge NSString *)kAXDescriptionAttribute,
    @"value" : (__bridge NSString *)kAXValueAttribute,
    @"help" : (__bridge NSString *)kAXHelpAttribute,
    @"placeholder" : @"AXPlaceholderValue",
    @"domId" : @"AXDOMIdentifier",
  };
  for (NSString *key in names) {
    NSString *text = stringOf(attribute(element, (__bridge CFStringRef)names[key]));
    if (text.length) node[key] = text;
  }
  id classes = attribute(element, (__bridge CFStringRef) @"AXDOMClassList");
  if ([classes isKindOfClass:[NSArray class]] && [classes count]) node[@"classes"] = classes;
  id enabled = attribute(element, kAXEnabledAttribute);
  if ([enabled isKindOfClass:[NSNumber class]] && ![enabled boolValue]) node[@"disabled"] = @YES;
  id focused = attribute(element, kAXFocusedAttribute);
  if ([focused isKindOfClass:[NSNumber class]] && [focused boolValue]) node[@"focused"] = @YES;
  id selected = attribute(element, kAXSelectedAttribute);
  if ([selected isKindOfClass:[NSNumber class]] && [selected boolValue]) node[@"selected"] = @YES;
  NSDictionary *frame = frameOf(element);
  if (frame) node[@"frame"] = frame;
  if (depth < kMaxDepth && nodeCount < kMaxNodes) {
    NSArray *children = childrenOf(element);
    NSMutableArray *out = [NSMutableArray array];
    [children enumerateObjectsUsingBlock:^(id child, NSUInteger i, BOOL *stop) {
      if (nodeCount >= kMaxNodes) {
        *stop = YES;
        return;
      }
      [out addObject:describe((__bridge AXUIElementRef)child, [path arrayByAddingObject:@(i)], depth + 1)];
    }];
    if (out.count) node[@"children"] = out;
  }
  return node;
}

static NSArray *windowsOf(AXUIElementRef app) {
  id windows = attribute(app, kAXWindowsAttribute);
  return [windows isKindOfClass:[NSArray class]] ? windows : @[];
}

static AXUIElementRef resolve(pid_t pid, NSString *path) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  NSArray *parts = [path componentsSeparatedByString:@"."];
  NSArray *level = windowsOf(app);
  id current = nil;
  for (NSString *part in parts) {
    NSInteger index = part.integerValue;
    if (index < 0 || index >= (NSInteger)level.count) return NULL;
    current = level[index];
    level = childrenOf((__bridge AXUIElementRef)current);
  }
  return current ? (AXUIElementRef)CFBridgingRetain(current) : NULL;
}

static int emit(id object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return 0;
}

static int failWith(NSString *message) {
  fprintf(stderr, "%s\n", message.UTF8String);
  return 1;
}

static void postKey(pid_t pid, UniChar character) {
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
  CGEventKeyboardSetUnicodeString(down, 1, &character);
  CGEventKeyboardSetUnicodeString(up, 1, &character);
  CGEventPostToPid(pid, down);
  CGEventPostToPid(pid, up);
  CFRelease(down);
  CFRelease(up);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) return failWith(@"usage: webview-ax trusted|tree|press|focus|setvalue|type ...");
    NSString *command = @(argv[1]);
    if ([command isEqualToString:@"trusted"]) return emit(@{@"trusted" : @(AXIsProcessTrusted())});
    if (!AXIsProcessTrusted())
      return failWith(@"this process is not trusted for Accessibility (System Settings > Privacy & Security > Accessibility)");
    if (argc < 3) return failWith(@"missing PID");
    pid_t pid = (pid_t)atoi(argv[2]);
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(app, 5.0);
    if ([command isEqualToString:@"tree"]) {
      NSMutableArray *windows = [NSMutableArray array];
      [windowsOf(app) enumerateObjectsUsingBlock:^(id window, NSUInteger i, BOOL *stop) {
        [windows addObject:describe((__bridge AXUIElementRef)window, @[ @(i) ], 0)];
      }];
      return emit(@{@"pid" : @(pid), @"windows" : windows, @"truncated" : @(nodeCount >= kMaxNodes)});
    }
    if ([command isEqualToString:@"type"]) {
      if (argc < 4) return failWith(@"usage: type PID TEXT [DELAY_MS]");
      NSString *text = @(argv[3]);
      useconds_t delay = (useconds_t)((argc > 4 ? atoi(argv[4]) : 25) * 1000);
      for (NSUInteger i = 0; i < text.length; i++) {
        postKey(pid, [text characterAtIndex:i]);
        usleep(delay);
      }
      return emit(@{@"typed" : @(text.length)});
    }
    if (argc < 4) return failWith(@"missing PATH");
    AXUIElementRef element = resolve(pid, @(argv[3]));
    if (!element) return failWith([NSString stringWithFormat:@"no element at %s", argv[3]]);
    AXError error = kAXErrorSuccess;
    if ([command isEqualToString:@"press"]) {
      error = AXUIElementPerformAction(element, kAXPressAction);
    } else if ([command isEqualToString:@"focus"]) {
      error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue);
    } else if ([command isEqualToString:@"setvalue"]) {
      if (argc < 5) return failWith(@"usage: setvalue PID PATH TEXT");
      AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue);
      error = AXUIElementSetAttributeValue(element, kAXValueAttribute, (__bridge CFStringRef) @(argv[4]));
    } else {
      return failWith([NSString stringWithFormat:@"unknown command %@", command]);
    }
    CFRelease(element);
    if (error != kAXErrorSuccess) return failWith([NSString stringWithFormat:@"%@ failed: AXError %d", command, error]);
    return emit(@{@"ok" : @YES});
  }
}
