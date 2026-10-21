import Foundation
import LocalAuthentication
import ParlorDeviceKeyCore
import Security

enum DeviceKeyError: LocalizedError {
    case keystore(String)
    case presenceRefused
    case unknownKey
    case badPayload

    var errorDescription: String? {
        switch self {
        case .keystore(let reason): return reason
        case .presenceRefused: return "The presence check did not complete."
        case .unknownKey: return "This device has no such key."
        case .badPayload: return "The payload is not base64url."
        }
    }
}

enum KeyRole: String {
    case signing
    case presence
}

struct StoredKey {
    let ref: SecKey
    let point: PublicPoint
    let keyId: String
    let inSecureEnclave: Bool
}

final class DeviceKeyStore {
    private let tagPrefix: String

    init(bundleId: String = Bundle.main.bundleIdentifier ?? "parlor") {
        tagPrefix = "\(bundleId).parlor.device."
    }

    func existing(_ role: KeyRole, context: LAContext? = nil) -> StoredKey? {
        var query = baseQuery(role)
        query[kSecReturnRef as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        if let context { query[kSecUseAuthenticationContext as String] = context }
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
            let item
        else { return nil }
        return describe(item as! SecKey)
    }

    func ensure(_ role: KeyRole) throws -> StoredKey {
        if let found = existing(role) { return found }
        if let created = try createInSecureEnclave(role) { return created }
        return try createInSoftware(role)
    }

    func canConfirmPresence() -> Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    func lookup(keyId: String, context: LAContext) -> (role: KeyRole, key: StoredKey)? {
        for role in [KeyRole.signing, .presence] {
            if let key = existing(role, context: context), key.keyId == keyId {
                return (role, key)
            }
        }
        return nil
    }

    func sign(_ key: StoredKey, role: KeyRole, payload: Data, context: LAContext) throws -> Data {
        if role == .presence && !key.inSecureEnclave {
            try confirmPresence(context)
        }
        var error: Unmanaged<CFError>?
        guard
            let der = SecKeyCreateSignature(
                key.ref, .ecdsaSignatureMessageX962SHA256, payload as CFData, &error)
        else {
            throw DeviceKeyError.keystore(
                error?.takeRetainedValue().localizedDescription ?? "The signature failed.")
        }
        guard let raw = KeyEncoding.rawSignature(fromDER: der as Data) else {
            throw DeviceKeyError.keystore("The keystore returned a malformed signature.")
        }
        return raw
    }

    private func confirmPresence(_ context: LAContext) throws {
        var denied: Error?
        let done = DispatchSemaphore(value: 0)
        context.evaluatePolicy(
            .deviceOwnerAuthentication, localizedReason: "Confirm it is you"
        ) { ok, error in
            if !ok { denied = error ?? DeviceKeyError.presenceRefused }
            done.signal()
        }
        done.wait()
        if denied != nil { throw DeviceKeyError.presenceRefused }
    }

    private func tag(_ role: KeyRole) -> Data {
        Data((tagPrefix + role.rawValue).utf8)
    }

    private func baseQuery(_ role: KeyRole) -> [String: Any] {
        [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag as String: tag(role),
        ]
    }

    private func describe(_ ref: SecKey) -> StoredKey? {
        guard let publicKey = SecKeyCopyPublicKey(ref),
            let representation = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?,
            let point = KeyEncoding.point(x963: representation)
        else { return nil }
        let attributes = SecKeyCopyAttributes(ref) as? [String: Any]
        let token = attributes?[kSecAttrTokenID as String] as? String
        return StoredKey(
            ref: ref,
            point: point,
            keyId: KeyEncoding.thumbprint(point),
            inSecureEnclave: token == (kSecAttrTokenIDSecureEnclave as String))
    }

    private func create(_ role: KeyRole, secureEnclave: Bool) throws -> StoredKey? {
        var privateAttributes: [String: Any] = [
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: tag(role),
        ]
        var attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
        ]
        if secureEnclave {
            var flags: SecAccessControlCreateFlags = [.privateKeyUsage]
            if role == .presence { flags.insert(.userPresence) }
            guard
                let access = SecAccessControlCreateWithFlags(
                    nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, nil)
            else { return nil }
            privateAttributes[kSecAttrAccessControl as String] = access
            attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
        } else {
            privateAttributes[kSecAttrAccessible as String] =
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        attributes[kSecPrivateKeyAttrs as String] = privateAttributes
        var error: Unmanaged<CFError>?
        guard let ref = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            if secureEnclave { return nil }
            throw DeviceKeyError.keystore(
                error?.takeRetainedValue().localizedDescription ?? "The key could not be created.")
        }
        return describe(ref)
    }

    private func createInSecureEnclave(_ role: KeyRole) throws -> StoredKey? {
        try create(role, secureEnclave: true)
    }

    private func createInSoftware(_ role: KeyRole) throws -> StoredKey {
        guard let key = try create(role, secureEnclave: false) else {
            throw DeviceKeyError.keystore("The key could not be created.")
        }
        return key
    }
}
