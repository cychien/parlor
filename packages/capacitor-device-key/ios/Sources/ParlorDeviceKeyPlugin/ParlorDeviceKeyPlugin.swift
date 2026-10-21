import Capacitor
import Foundation
import LocalAuthentication
import ParlorDeviceKeyCore

@objc(ParlorDeviceKeyPlugin)
public class ParlorDeviceKeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ParlorDeviceKeyPlugin"
    public let jsName = "ParlorDeviceKey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "publicKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise),
    ]

    private let store = DeviceKeyStore()
    private let queue = DispatchQueue(label: "dev.parlor.device-key")

    @objc func publicKeys(_ call: CAPPluginCall) {
        guard let challenge = call.getString("challenge") else {
            call.reject("challenge is required")
            return
        }
        let wantsPresence = call.getBool("presence") ?? false
        queue.async {
            do {
                let signing = try self.store.ensure(.signing)
                var presence: StoredKey?
                if wantsPresence && self.store.canConfirmPresence() {
                    presence = try? self.store.ensure(.presence)
                }
                let enrollment = KeyEncoding.enrollmentBytes(
                    challenge: challenge,
                    signing: signing.point,
                    presence: presence.map { ($0.keyId, $0.point) })
                let proof = try self.store.sign(
                    signing, role: .signing, payload: enrollment, context: LAContext())
                var reply: [String: Any] = [
                    "signing": ["keyId": signing.keyId, "publicKey": signing.point.jwk],
                    "proof": ["signature": KeyEncoding.base64url(proof)],
                ]
                if let presence {
                    reply["presence"] = ["keyId": presence.keyId, "publicKey": presence.point.jwk]
                }
                call.resolve(reply)
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func sign(_ call: CAPPluginCall) {
        guard let keyId = call.getString("keyId"), let encoded = call.getString("payload") else {
            call.reject("keyId and payload are required")
            return
        }
        guard let payload = KeyEncoding.data(fromBase64url: encoded) else {
            call.reject(DeviceKeyError.badPayload.localizedDescription)
            return
        }
        queue.async {
            let context = LAContext()
            context.localizedReason = "Confirm it is you"
            guard let found = self.store.lookup(keyId: keyId, context: context) else {
                call.reject(DeviceKeyError.unknownKey.localizedDescription)
                return
            }
            do {
                let signature = try self.store.sign(
                    found.key, role: found.role, payload: payload, context: context)
                call.resolve(["signature": KeyEncoding.base64url(signature)])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}
