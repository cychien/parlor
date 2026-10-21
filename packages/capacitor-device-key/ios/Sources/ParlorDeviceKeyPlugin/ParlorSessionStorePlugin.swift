import Capacitor
import Foundation
import Security

@objc(ParlorSessionStorePlugin)
public class ParlorSessionStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ParlorSessionStorePlugin"
    public let jsName = "ParlorSessionStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
    ]

    private let account = "parlor.session"

    private var identity: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "parlor",
            kSecAttrAccount as String: account,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        var query = identity
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve([:])
        } else if status == errSecSuccess, let data = item as? Data,
            let value = String(data: data, encoding: .utf8)
        {
            call.resolve(["value": value])
        } else {
            call.reject("The Keychain could not be read (\(status)).")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        let deleted = SecItemDelete(identity as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
            call.reject("The Keychain could not be updated (\(deleted)).")
            return
        }
        guard let value = call.getString("value"), !value.isEmpty else {
            call.resolve()
            return
        }
        var attributes = identity
        attributes[kSecValueData as String] = Data(value.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("The Keychain could not be updated (\(status)).")
        }
    }
}
