// Deletes the Mac app's device key items named by the Drive contract, and nothing else:
//   delete-device-key LABEL TAG
// SecItemDelete with kSecClassKey, kSecAttrLabel = LABEL and kSecAttrApplicationTag = TAG, until
// none is left. Prints {"label","tag","deleted","status"}; exit 1 on any status other than
// success or errSecItemNotFound. It never lists or reads the Keychain.
#import <Foundation/Foundation.h>
#import <Security/Security.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) {
      fprintf(stderr, "usage: delete-device-key LABEL TAG\n");
      return 2;
    }
    NSString *label = @(argv[1]);
    NSData *tag = [@(argv[2]) dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *query = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassKey,
      (__bridge id)kSecAttrLabel : label,
      (__bridge id)kSecAttrApplicationTag : tag,
    };
    int deleted = 0;
    OSStatus status = errSecSuccess;
    for (int round = 0; round < 20; round++) {
      status = SecItemDelete((__bridge CFDictionaryRef)query);
      if (status != errSecSuccess) break;
      deleted++;
    }
    NSString *message = CFBridgingRelease(SecCopyErrorMessageString(status, NULL)) ?: @"";
    NSDictionary *out = @{
      @"label" : label,
      @"tag" : @(argv[2]),
      @"deleted" : @(deleted),
      @"status" : @(status),
      @"message" : message,
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    return status == errSecSuccess || status == errSecItemNotFound ? 0 : 1;
  }
}
