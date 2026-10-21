use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::keystore::{self, PublicPoint};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicJwk {
    pub kty: &'static str,
    pub crv: &'static str,
    pub x: String,
    pub y: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyReport {
    pub key_id: String,
    pub public_key: PublicJwk,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Proof {
    pub signature: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PublicKeys {
    pub signing: KeyReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence: Option<KeyReport>,
    pub proof: Proof,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Signature {
    pub signature: String,
}

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn thumbprint(x: &str, y: &str) -> String {
    let canonical = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
    encode(&Sha256::digest(canonical.as_bytes()))
}

pub fn report_of(point: &PublicPoint) -> KeyReport {
    let (x, y) = (encode(&point.x), encode(&point.y));
    KeyReport {
        key_id: thumbprint(&x, &y),
        public_key: PublicJwk {
            kty: "EC",
            crv: "P-256",
            x,
            y,
        },
    }
}

fn point_json(key: &PublicJwk) -> String {
    format!(
        r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
        key.x, key.y
    )
}

pub fn enrollment_bytes(
    challenge: &str,
    signing: &KeyReport,
    presence: Option<&KeyReport>,
) -> Vec<u8> {
    let challenge = serde_json::to_string(challenge).unwrap_or_default();
    let presence = match presence {
        Some(report) => format!(
            r#"{{"format":"es256-raw","id":"{}","publicKey":{}}}"#,
            report.key_id,
            point_json(&report.public_key)
        ),
        None => "null".to_string(),
    };
    format!(
        r#"{{"challenge":{challenge},"presence":{presence},"signing":{}}}"#,
        point_json(&signing.public_key)
    )
    .into_bytes()
}

pub fn der_to_raw(der: &[u8]) -> Result<[u8; 64], String> {
    fn length(bytes: &[u8], at: &mut usize) -> Result<usize, String> {
        let first = *bytes.get(*at).ok_or("short signature")?;
        *at += 1;
        if first < 0x80 {
            return Ok(first as usize);
        }
        let count = (first & 0x7f) as usize;
        let mut value = 0usize;
        for _ in 0..count {
            value = (value << 8) | *bytes.get(*at).ok_or("short signature")? as usize;
            *at += 1;
        }
        Ok(value)
    }
    fn integer(bytes: &[u8], at: &mut usize) -> Result<[u8; 32], String> {
        if bytes.get(*at) != Some(&0x02) {
            return Err("not an integer".to_string());
        }
        *at += 1;
        let size = length(bytes, at)?;
        let body = bytes.get(*at..*at + size).ok_or("short signature")?;
        *at += size;
        let trimmed = match body.iter().position(|byte| *byte != 0) {
            Some(first) => &body[first..],
            None => &[0u8][..],
        };
        if trimmed.len() > 32 {
            return Err("integer too long".to_string());
        }
        let mut out = [0u8; 32];
        out[32 - trimmed.len()..].copy_from_slice(trimmed);
        Ok(out)
    }
    let mut at = 0;
    if der.first() != Some(&0x30) {
        return Err("not a sequence".to_string());
    }
    at += 1;
    length(der, &mut at)?;
    let r = integer(der, &mut at)?;
    let s = integer(der, &mut at)?;
    let mut raw = [0u8; 64];
    raw[..32].copy_from_slice(&r);
    raw[32..].copy_from_slice(&s);
    Ok(raw)
}

pub fn decode_payload(payload: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(payload).map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn parlor_device_key_public(
    app: AppHandle,
    presence: bool,
    challenge: String,
) -> Result<PublicKeys, String> {
    let identifier = app.config().identifier.clone();
    blocking(move || {
        let signing = report_of(&keystore::signing_key(&identifier)?.point()?);
        let presence = if presence {
            keystore::presence_key(&identifier)?
                .map(|key| key.point().map(|point| report_of(&point)))
                .transpose()?
        } else {
            None
        };
        let bytes = enrollment_bytes(&challenge, &signing, presence.as_ref());
        let raw = keystore::signing_key(&identifier)?.sign(&bytes)?;
        Ok(PublicKeys {
            signing,
            presence,
            proof: Proof {
                signature: encode(&raw),
            },
        })
    })
    .await
}

#[tauri::command]
pub async fn parlor_device_key_sign(
    app: AppHandle,
    key_id: String,
    payload: String,
) -> Result<Signature, String> {
    let identifier = app.config().identifier.clone();
    blocking(move || {
        let bytes = decode_payload(&payload)?;
        let key = keystore::find(&identifier, &key_id)?;
        Ok(Signature {
            signature: encode(&key.sign(&bytes)?),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(x: &str, y: &str) -> KeyReport {
        KeyReport {
            key_id: thumbprint(x, y),
            public_key: PublicJwk {
                kty: "EC",
                crv: "P-256",
                x: x.to_string(),
                y: y.to_string(),
            },
        }
    }

    #[test]
    fn the_enrollment_bytes_match_the_canonical_json_of_the_web_adapter() {
        let signing = report("AAA", "BBB");
        let text = String::from_utf8(enrollment_bytes("chal", &signing, None)).unwrap();
        assert_eq!(
            text,
            r#"{"challenge":"chal","presence":null,"signing":{"crv":"P-256","kty":"EC","x":"AAA","y":"BBB"}}"#
        );
        let presence = report("CCC", "DDD");
        let text = String::from_utf8(enrollment_bytes("chal", &signing, Some(&presence))).unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"challenge":"chal","presence":{{"format":"es256-raw","id":"{}","publicKey":{{"crv":"P-256","kty":"EC","x":"CCC","y":"DDD"}}}},"signing":{{"crv":"P-256","kty":"EC","x":"AAA","y":"BBB"}}}}"#,
                presence.key_id
            )
        );
    }

    #[test]
    fn the_key_id_is_the_sha256_thumbprint_of_the_sorted_point() {
        assert_eq!(
            thumbprint("x", "y"),
            encode(&Sha256::digest(
                br#"{"crv":"P-256","kty":"EC","x":"x","y":"y"}"#
            ))
        );
        assert_eq!(thumbprint("x", "y").len(), 43);
    }

    #[test]
    fn der_signatures_become_raw_r_and_s() {
        let mut der = vec![0x30, 0x44, 0x02, 0x20];
        der.extend([1u8; 32]);
        der.extend([0x02, 0x20]);
        der.extend([2u8; 32]);
        let raw = der_to_raw(&der).unwrap();
        assert_eq!(&raw[..32], &[1u8; 32]);
        assert_eq!(&raw[32..], &[2u8; 32]);
    }

    #[test]
    fn der_integers_lose_their_sign_padding_and_gain_leading_zeros() {
        let mut der = vec![0x30, 0x26, 0x02, 0x21, 0x00];
        der.extend([0xffu8; 32]);
        der.extend([0x02, 0x01, 0x05]);
        let raw = der_to_raw(&der).unwrap();
        assert_eq!(&raw[..32], &[0xffu8; 32]);
        assert_eq!(raw[63], 5);
        assert_eq!(&raw[32..63], &[0u8; 31]);
        assert!(der_to_raw(&[0x31, 0x00]).is_err());
    }

    #[test]
    fn a_missing_presence_key_is_left_out_of_the_reply() {
        let keys = PublicKeys {
            signing: report("a", "b"),
            presence: None,
            proof: Proof {
                signature: "s".to_string(),
            },
        };
        let json = serde_json::to_value(&keys).unwrap();
        assert!(json.get("presence").is_none());
        assert_eq!(json["signing"]["publicKey"]["kty"], "EC");
        assert_eq!(json["signing"]["keyId"], keys.signing.key_id);
    }
}
