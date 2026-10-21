// The Mac app's device key items named by the Drive contract, and nothing else:
//   device-key delete LABEL TAG    SecItemDelete until none is left
//   device-key exists LABEL TAG    whether one exists, without reading it
// Both match kSecClassKey with kSecAttrLabel = LABEL and kSecAttrApplicationTag = TAG. Prints
// {"label","tag","deleted"|"exists","status","message"}; exit 1 on any status other than success
// or errSecItemNotFound. It never lists the Keychain or reads a key.
#import <Foundation/Foundation.h>
#import <Security/Security.h>

static int emit(NSDictionary *out, OSStatus status) {
  NSMutableDictionary *full = [out mutableCopy];
  full[@"status"] = @(status);
  full[@"message"] = CFBridgingRelease(SecCopyErrorMessageString(status, NULL)) ?: @"";
  NSData *json = [NSJSONSerialization dataWithJSONObject:full options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  return status == errSecSuccess || status == errSecItemNotFound ? 0 : 1;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 4) {
      fprintf(stderr, "usage: device-key delete|exists LABEL TAG\n");
      return 2;
    }
    NSString *command = @(argv[1]);
    NSString *label = @(argv[2]);
    NSDictionary *query = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassKey,
      (__bridge id)kSecAttrLabel : label,
      (__bridge id)kSecAttrApplicationTag : [@(argv[3]) dataUsingEncoding:NSUTF8StringEncoding],
    };
    NSDictionary *names = @{@"label" : label, @"tag" : @(argv[3])};
    if ([command isEqualToString:@"exists"]) {
      NSMutableDictionary *one = [query mutableCopy];
      one[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
      OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)one, NULL);
      NSMutableDictionary *out = [names mutableCopy];
      out[@"exists"] = status == errSecSuccess ? @YES : @NO;
      return emit(out, status);
    }
    if ([command isEqualToString:@"delete"]) {
      int deleted = 0;
      OSStatus status = errSecSuccess;
      for (int round = 0; round < 20; round++) {
        status = SecItemDelete((__bridge CFDictionaryRef)query);
        if (status != errSecSuccess) break;
        deleted++;
      }
      NSMutableDictionary *out = [names mutableCopy];
      out[@"deleted"] = @(deleted);
      return emit(out, status);
    }
    fprintf(stderr, "usage: device-key delete|exists LABEL TAG\n");
    return 2;
  }
}
