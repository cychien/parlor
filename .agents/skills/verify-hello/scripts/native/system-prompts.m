// The macOS windows and permissions that decide whether a check can run without a human:
//   system-prompts windows OWNER...      on-screen windows of the processes named OWNER, as JSON
//                                        [{owner, pid, frame, subrole, texts, buttons: [{name, path}]}]; texts
//                                        are static texts only (never a field's value), and a
//                                        button's path is the one webview-ax press takes
//   system-prompts automation BUNDLE_ID  whether this process may send Apple Events to that app,
//                                        decided without asking the user
//   system-prompts screen-capture        whether this process may capture other apps' windows
//   system-prompts trusted               whether this process is trusted for Accessibility
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>

static int emit(id object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return 0;
}

static id attribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return nil;
  return CFBridgingRelease(value);
}

static NSString *stringOf(id value) {
  if ([value isKindOfClass:[NSString class]]) return value;
  if ([value isKindOfClass:[NSAttributedString class]]) return [value string];
  return nil;
}

static NSArray *arrayOf(id value) { return [value isKindOfClass:[NSArray class]] ? value : @[]; }

static CGRect frameOf(AXUIElementRef element) {
  CGPoint p = CGPointZero;
  CGSize s = CGSizeZero;
  id position = attribute(element, kAXPositionAttribute);
  id size = attribute(element, kAXSizeAttribute);
  if (position) AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &p);
  if (size) AXValueGetValue((__bridge AXValueRef)size, kAXValueTypeCGSize, &s);
  return CGRectMake(p.x, p.y, s.width, s.height);
}

static void collect(AXUIElementRef element, NSString *path, int depth, NSMutableArray *texts,
                    NSMutableArray *buttons) {
  if (depth > 30 || texts.count + buttons.count > 200) return;
  NSString *role = stringOf(attribute(element, kAXRoleAttribute));
  if ([role isEqualToString:(__bridge NSString *)kAXStaticTextRole]) {
    NSString *text = stringOf(attribute(element, kAXValueAttribute)) ?: stringOf(attribute(element, kAXTitleAttribute));
    if (text.length) [texts addObject:text];
  }
  if ([role isEqualToString:(__bridge NSString *)kAXButtonRole]) {
    NSString *name = stringOf(attribute(element, kAXTitleAttribute)) ?: stringOf(attribute(element, kAXDescriptionAttribute));
    if (name.length) [buttons addObject:@{@"name" : name, @"path" : path}];
  }
  [arrayOf(attribute(element, kAXChildrenAttribute)) enumerateObjectsUsingBlock:^(id child, NSUInteger i, BOOL *stop) {
    collect((__bridge AXUIElementRef)child, [NSString stringWithFormat:@"%@.%lu", path, (unsigned long)i], depth + 1,
            texts, buttons);
  }];
}

static NSArray *axWindows(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app, 2.0);
  NSMutableArray *out = [NSMutableArray array];
  [arrayOf(attribute(app, kAXWindowsAttribute)) enumerateObjectsUsingBlock:^(id window, NSUInteger i, BOOL *stop) {
    NSMutableArray *texts = [NSMutableArray array];
    NSMutableArray *buttons = [NSMutableArray array];
    NSString *title = stringOf(attribute((__bridge AXUIElementRef)window, kAXTitleAttribute));
    if (title.length) [texts addObject:title];
    collect((__bridge AXUIElementRef)window, [NSString stringWithFormat:@"%lu", (unsigned long)i], 0, texts, buttons);
    [out addObject:@{
      @"frame" : [NSValue valueWithRect:NSRectFromCGRect(frameOf((__bridge AXUIElementRef)window))],
      @"subrole" : stringOf(attribute((__bridge AXUIElementRef)window, kAXSubroleAttribute)) ?: @"",
      @"texts" : texts,
      @"buttons" : buttons,
    }];
  }];
  CFRelease(app);
  return out;
}

static int windows(NSSet *owners) {
  NSArray *all = CFBridgingRelease(CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  NSMutableDictionary *axByPid = [NSMutableDictionary dictionary];
  NSMutableArray *found = [NSMutableArray array];
  for (NSDictionary *window in all) {
    NSString *owner = window[(__bridge NSString *)kCGWindowOwnerName];
    if (![owners containsObject:owner]) continue;
    if ([window[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0) continue;
    CGRect bounds = CGRectZero;
    CGRectMakeWithDictionaryRepresentation(
        (__bridge CFDictionaryRef)window[(__bridge NSString *)kCGWindowBounds], &bounds);
    if (bounds.size.width < 120 || bounds.size.height < 60) continue;
    NSNumber *pid = window[(__bridge NSString *)kCGWindowOwnerPID];
    if (!axByPid[pid]) axByPid[pid] = AXIsProcessTrusted() ? axWindows(pid.intValue) : @[];
    NSDictionary *match = nil;
    for (NSDictionary *ax in axByPid[pid]) {
      CGRect frame = NSRectToCGRect([ax[@"frame"] rectValue]);
      if (fabs(frame.origin.x - bounds.origin.x) < 8 && fabs(frame.origin.y - bounds.origin.y) < 8) match = ax;
    }
    if (!match && [axByPid[pid] count] == 1) match = [axByPid[pid] firstObject];
    [found addObject:@{
      @"owner" : owner,
      @"pid" : pid,
      @"windowId" : window[(__bridge NSString *)kCGWindowNumber] ?: @0,
      @"frame" : @{@"x" : @(bounds.origin.x), @"y" : @(bounds.origin.y), @"w" : @(bounds.size.width), @"h" : @(bounds.size.height)},
      @"subrole" : match[@"subrole"] ?: @"",
      @"texts" : match[@"texts"] ?: @[],
      @"buttons" : match[@"buttons"] ?: @[],
    }];
  }
  return emit(found);
}

static int automation(NSString *bundleId) {
  NSAppleEventDescriptor *target = [NSAppleEventDescriptor descriptorWithBundleIdentifier:bundleId];
  OSStatus status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false);
  if (status == procNotFound) {
    NSURL *url = [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:bundleId];
    if (url) {
      NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
      config.activates = NO;
      config.hides = YES;
      dispatch_semaphore_t opened = dispatch_semaphore_create(0);
      [[NSWorkspace sharedWorkspace] openApplicationAtURL:url
                                            configuration:config
                                        completionHandler:^(NSRunningApplication *app, NSError *error) {
                                          dispatch_semaphore_signal(opened);
                                        }];
      dispatch_semaphore_wait(opened, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
      for (int i = 0; i < 20 && status == procNotFound; i++) {
        usleep(250000);
        status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false);
      }
    }
  }
  NSString *state = status == noErr                                ? @"granted"
                    : status == errAEEventNotPermitted              ? @"denied"
                    : status == errAEEventWouldRequireUserConsent   ? @"not determined"
                                                                    : @"unknown";
  return emit(@{@"target" : bundleId, @"state" : state, @"status" : @(status)});
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *command = argc > 1 ? @(argv[1]) : @"";
    if ([command isEqualToString:@"windows"]) {
      NSMutableSet *owners = [NSMutableSet set];
      for (int i = 2; i < argc; i++) [owners addObject:@(argv[i])];
      return windows(owners);
    }
    if ([command isEqualToString:@"automation"] && argc == 3) return automation(@(argv[2]));
    if ([command isEqualToString:@"screen-capture"]) return emit(@{@"granted" : CGPreflightScreenCaptureAccess() ? @YES : @NO});
    if ([command isEqualToString:@"trusted"]) return emit(@{@"trusted" : AXIsProcessTrusted() ? @YES : @NO});
    fprintf(stderr, "usage: system-prompts windows OWNER... | automation BUNDLE_ID | screen-capture | trusted\n");
    return 2;
  }
}
