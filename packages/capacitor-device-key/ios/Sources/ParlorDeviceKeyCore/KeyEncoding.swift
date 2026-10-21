import CryptoKit
import Foundation

public struct PublicPoint: Equatable {
    public let x: String
    public let y: String

    public init(x: String, y: String) {
        self.x = x
        self.y = y
    }

    public var jwk: [String: String] {
        ["kty": "EC", "crv": "P-256", "x": x, "y": y]
    }
}

public enum KeyEncoding {
    public static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func data(fromBase64url text: String) -> Data? {
        var base64 = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }

    public static func point(x963 representation: Data) -> PublicPoint? {
        guard representation.count == 65, representation.first == 0x04 else { return nil }
        let bytes = representation.dropFirst()
        return PublicPoint(
            x: base64url(Data(bytes.prefix(32))),
            y: base64url(Data(bytes.suffix(32))))
    }

    public static func thumbprint(_ point: PublicPoint) -> String {
        let text = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(point.x)\",\"y\":\"\(point.y)\"}"
        return base64url(Data(SHA256.hash(data: Data(text.utf8))))
    }

    public static func enrollmentBytes(
        challenge: String,
        signing: PublicPoint,
        presence: (keyId: String, point: PublicPoint)?
    ) -> Data {
        let presenceText =
            presence.map {
                "{\"format\":\"es256-raw\",\"id\":\(quoted($0.keyId)),\"publicKey\":\(jwkText($0.point))}"
            } ?? "null"
        let text =
            "{\"challenge\":\(quoted(challenge)),\"presence\":\(presenceText),\"signing\":\(jwkText(signing))}"
        return Data(text.utf8)
    }

    public static func rawSignature(fromDER der: Data) -> Data? {
        let bytes = [UInt8](der)
        var at = 0
        guard let sequence = readTag(bytes, &at, expecting: 0x30), sequence == bytes.count - at
        else { return nil }
        guard let r = readInteger(bytes, &at), let s = readInteger(bytes, &at), at == bytes.count
        else { return nil }
        return Data(r + s)
    }

    private static func jwkText(_ point: PublicPoint) -> String {
        "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\(quoted(point.x)),\"y\":\(quoted(point.y))}"
    }

    private static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    private static func readTag(_ bytes: [UInt8], _ at: inout Int, expecting tag: UInt8) -> Int? {
        guard at < bytes.count, bytes[at] == tag else { return nil }
        at += 1
        guard at < bytes.count else { return nil }
        let first = Int(bytes[at])
        at += 1
        if first < 0x80 { return first }
        let count = first & 0x7f
        guard count >= 1, count <= 2, at + count <= bytes.count else { return nil }
        var length = 0
        for _ in 0..<count {
            length = (length << 8) | Int(bytes[at])
            at += 1
        }
        return length
    }

    private static func readInteger(_ bytes: [UInt8], _ at: inout Int) -> [UInt8]? {
        guard let length = readTag(bytes, &at, expecting: 0x02), length > 0,
            at + length <= bytes.count
        else { return nil }
        var value = Array(bytes[at..<(at + length)])
        at += length
        while value.count > 1, value.first == 0 { value.removeFirst() }
        guard value.count <= 32 else { return nil }
        return [UInt8](repeating: 0, count: 32 - value.count) + value
    }
}
