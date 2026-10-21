import CryptoKit
import XCTest

@testable import ParlorDeviceKeyCore

final class KeyEncodingTests: XCTestCase {
    private let signing = PublicPoint(
        x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
        y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0")
    private let presence = PublicPoint(
        x: "WKn-ZIGevcwGIyyrzFoZNBdaq9_TsDRN9lH8s6Ra6vc",
        y: "KE0n8UyW-WMcIRb9_SkfD1BO2nO8w0z0K_Bm3b1o9uw")

    func testThumbprintMatchesTheWebAdapter() {
        XCTAssertEqual(
            KeyEncoding.thumbprint(signing), "oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U")
    }

    func testEnrollmentBytesMatchTheCanonicalJson() {
        let bytes = KeyEncoding.enrollmentBytes(challenge: "AQID-g", signing: signing, presence: nil)
        XCTAssertEqual(
            String(decoding: bytes, as: UTF8.self),
            "{\"challenge\":\"AQID-g\",\"presence\":null,\"signing\":{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(signing.x)\",\"y\":\"\(signing.y)\"}}"
        )
        let both = KeyEncoding.enrollmentBytes(
            challenge: "AQID-g", signing: signing,
            presence: (KeyEncoding.thumbprint(presence), presence))
        XCTAssertEqual(
            String(decoding: both, as: UTF8.self),
            "{\"challenge\":\"AQID-g\",\"presence\":{\"format\":\"es256-raw\",\"id\":\"HePMXFv0dmgSDC07-rfMd1T6M1tz4TSm2ovWfz3HKvc\",\"publicKey\":{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(presence.x)\",\"y\":\"\(presence.y)\"}},\"signing\":{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(signing.x)\",\"y\":\"\(signing.y)\"}}"
        )
    }

    func testPointFromX963SplitsTheCoordinates() {
        let key = P256.Signing.PrivateKey().publicKey
        let raw = key.rawRepresentation
        let point = KeyEncoding.point(x963: key.x963Representation)
        XCTAssertEqual(point?.x, KeyEncoding.base64url(raw.prefix(32)))
        XCTAssertEqual(point?.y, KeyEncoding.base64url(raw.suffix(32)))
        XCTAssertNil(KeyEncoding.point(x963: raw))
    }

    func testDerSignaturesBecomeRawRAndS() throws {
        let key = P256.Signing.PrivateKey()
        for round in 0..<64 {
            let signature = try key.signature(for: Data("payload \(round)".utf8))
            XCTAssertEqual(
                KeyEncoding.rawSignature(fromDER: signature.derRepresentation),
                signature.rawRepresentation)
        }
    }

    func testMalformedDerIsRefused() {
        XCTAssertNil(KeyEncoding.rawSignature(fromDER: Data([0x30, 0x02, 0x02, 0x00])))
        XCTAssertNil(KeyEncoding.rawSignature(fromDER: Data()))
    }

    func testBase64urlRoundTrips() {
        let data = Data([1, 2, 3, 250])
        XCTAssertEqual(KeyEncoding.base64url(data), "AQID-g")
        XCTAssertEqual(KeyEncoding.data(fromBase64url: "AQID-g"), data)
    }
}
