pub struct PublicPoint {
    pub x: Vec<u8>,
    pub y: Vec<u8>,
}

#[cfg(target_os = "macos")]
pub use apple::{find, presence_key, signing_key};

#[cfg(not(target_os = "macos"))]
pub use unsupported::{find, presence_key, signing_key};

#[cfg(target_os = "macos")]
mod apple {
    use std::ffi::c_void;
    use std::sync::Mutex;
    use std::sync::mpsc;

    use block2::RcBlock;
    use core_foundation::base::ToVoid;
    use core_foundation::dictionary::{CFDictionary, CFMutableDictionary};
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use security_framework::key::{Algorithm, SecKey};
    use security_framework_sys::item::kSecAttrTokenID;

    use super::PublicPoint;
    use crate::device_key::{der_to_raw, report_of};

    #[cfg(not(debug_assertions))]
    use keychain::{create, stored};
    #[cfg(debug_assertions)]
    use vault::{create, stored};

    const SIGNING: &str = "signing";
    const PRESENCE: &str = "presence";
    const PRESENCE_REASON: &str = "Confirm it is you to answer your agent";

    static CREATING: Mutex<()> = Mutex::new(());

    pub struct Key {
        key: SecKey,
        presence: bool,
    }

    fn dictionary(pairs: Vec<(*const c_void, *const c_void)>) -> CFDictionary {
        let mut dictionary = CFMutableDictionary::new();
        for (key, value) in pairs {
            dictionary.set(key, value);
        }
        dictionary.to_immutable()
    }

    #[cfg(not(debug_assertions))]
    mod keychain {
        use core_foundation::base::{TCFType, ToVoid};
        use core_foundation::boolean::CFBoolean;
        use core_foundation::data::CFData;
        use core_foundation::number::CFNumber;
        use core_foundation::string::CFString;
        use core_foundation_sys::base::CFTypeRef;
        use core_foundation_sys::string::CFStringRef;
        use security_framework::access_control::{ProtectionMode, SecAccessControl};
        use security_framework::key::SecKey;
        use security_framework_sys::access_control::{
            kSecAccessControlPrivateKeyUsage, kSecAccessControlUserPresence,
        };
        use security_framework_sys::base::{SecKeyRef, errSecItemNotFound};
        use security_framework_sys::item::{
            kSecAttrAccessControl, kSecAttrIsPermanent, kSecAttrKeyClass, kSecAttrKeyClassPrivate,
            kSecAttrKeySizeInBits, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom, kSecAttrLabel,
            kSecAttrTokenID, kSecAttrTokenIDSecureEnclave, kSecClass, kSecClassKey,
            kSecPrivateKeyAttrs, kSecReturnRef,
        };
        use security_framework_sys::keychain_item::SecItemCopyMatching;

        use super::{can_evaluate, dictionary};

        #[link(name = "Security", kind = "framework")]
        unsafe extern "C" {
            static kSecAttrApplicationTag: CFStringRef;
        }

        fn tag(identifier: &str, name: &str) -> Vec<u8> {
            format!("{identifier}.device-key.{name}").into_bytes()
        }

        fn lookup(tag: &[u8]) -> Result<Option<SecKey>, String> {
            let tag = CFData::from_buffer(tag);
            let wanted = CFBoolean::true_value();
            let query = unsafe {
                dictionary(vec![
                    (kSecClass.to_void(), kSecClassKey.to_void()),
                    (kSecAttrApplicationTag.to_void(), tag.to_void()),
                    (
                        kSecAttrKeyClass.to_void(),
                        kSecAttrKeyClassPrivate.to_void(),
                    ),
                    (kSecReturnRef.to_void(), wanted.to_void()),
                ])
            };
            let mut found: CFTypeRef = std::ptr::null();
            let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut found) };
            if status == errSecItemNotFound {
                return Ok(None);
            }
            if status != 0 || found.is_null() {
                return Err(format!("Keychain lookup failed ({status})"));
            }
            Ok(Some(unsafe {
                SecKey::wrap_under_create_rule(found as SecKeyRef)
            }))
        }

        #[allow(deprecated)]
        fn generate(
            tag: &[u8],
            enclave: bool,
            presence: bool,
            label: &str,
        ) -> Result<SecKey, String> {
            let tag = CFData::from_buffer(tag);
            let permanent = CFBoolean::true_value();
            let size = CFNumber::from(256);
            let label = CFString::new(label);
            let access = if enclave {
                let flags = kSecAccessControlPrivateKeyUsage
                    | if presence {
                        kSecAccessControlUserPresence
                    } else {
                        0
                    };
                Some(
                    SecAccessControl::create_with_protection(
                        Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                        flags,
                    )
                    .map_err(|e| e.to_string())?,
                )
            } else {
                None
            };
            let mut private = vec![
                (
                    unsafe { kSecAttrIsPermanent }.to_void(),
                    permanent.to_void(),
                ),
                (unsafe { kSecAttrApplicationTag }.to_void(), tag.to_void()),
            ];
            if let Some(access) = &access {
                private.push((unsafe { kSecAttrAccessControl }.to_void(), access.to_void()));
            }
            let private = dictionary(private);
            let mut attributes = vec![
                (
                    unsafe { kSecAttrKeyType }.to_void(),
                    unsafe { kSecAttrKeyTypeECSECPrimeRandom }.to_void(),
                ),
                (unsafe { kSecAttrKeySizeInBits }.to_void(), size.to_void()),
                (unsafe { kSecAttrLabel }.to_void(), label.to_void()),
                (unsafe { kSecPrivateKeyAttrs }.to_void(), private.to_void()),
            ];
            if enclave {
                attributes.push((
                    unsafe { kSecAttrTokenID }.to_void(),
                    unsafe { kSecAttrTokenIDSecureEnclave }.to_void(),
                ));
            }
            // `GenerateKeyOptions` cannot carry the application tag the key is found by
            SecKey::generate(dictionary(attributes)).map_err(|e| e.to_string())
        }

        pub fn stored(identifier: &str, name: &str) -> Result<Option<SecKey>, String> {
            lookup(&tag(identifier, name))
        }

        pub fn create(
            identifier: &str,
            name: &str,
            presence: bool,
        ) -> Result<Option<SecKey>, String> {
            let tag = tag(identifier, name);
            let label = format!("{identifier} device {name} key");
            match generate(&tag, true, presence, &label) {
                Ok(key) => Ok(Some(key)),
                Err(_) if presence && !can_evaluate() => Ok(None),
                Err(_) => generate(&tag, false, presence, &label).map(Some),
            }
        }
    }

    #[cfg(debug_assertions)]
    mod vault {
        use base64::Engine;
        use base64::engine::general_purpose::STANDARD;
        use core_foundation::base::{TCFType, ToVoid};
        use core_foundation::data::CFData;
        use core_foundation::error::CFError;
        use core_foundation::number::CFNumber;
        use security_framework::key::SecKey;
        use security_framework_sys::item::{
            kSecAttrKeyClass, kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits, kSecAttrKeyType,
            kSecAttrKeyTypeECSECPrimeRandom,
        };
        use security_framework_sys::key::SecKeyCreateWithData;

        use super::{can_evaluate, dictionary};
        use crate::dev_vault;

        fn entry(name: &str) -> String {
            format!("device-key.{name}")
        }

        pub fn stored(identifier: &str, name: &str) -> Result<Option<SecKey>, String> {
            let Some(encoded) = dev_vault::get(identifier, &entry(name))? else {
                return Ok(None);
            };
            let bytes = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
            let data = CFData::from_buffer(&bytes);
            let attributes = unsafe {
                dictionary(vec![
                    (
                        kSecAttrKeyType.to_void(),
                        kSecAttrKeyTypeECSECPrimeRandom.to_void(),
                    ),
                    (
                        kSecAttrKeyClass.to_void(),
                        kSecAttrKeyClassPrivate.to_void(),
                    ),
                ])
            };
            let mut error = std::ptr::null_mut();
            let key = unsafe {
                SecKeyCreateWithData(
                    data.as_concrete_TypeRef(),
                    attributes.as_concrete_TypeRef(),
                    &mut error,
                )
            };
            if key.is_null() {
                return Err(unsafe { CFError::wrap_under_create_rule(error) }.to_string());
            }
            Ok(Some(unsafe { SecKey::wrap_under_create_rule(key) }))
        }

        pub fn create(
            identifier: &str,
            name: &str,
            presence: bool,
        ) -> Result<Option<SecKey>, String> {
            if presence && !can_evaluate() {
                return Ok(None);
            }
            let size = CFNumber::from(256);
            let attributes = dictionary(vec![
                (
                    unsafe { kSecAttrKeyType }.to_void(),
                    unsafe { kSecAttrKeyTypeECSECPrimeRandom }.to_void(),
                ),
                (unsafe { kSecAttrKeySizeInBits }.to_void(), size.to_void()),
            ]);
            #[allow(deprecated)]
            let key = SecKey::generate(attributes).map_err(|e| e.to_string())?;
            let private = key
                .external_representation()
                .ok_or("The new key cannot be exported.")?;
            dev_vault::set(
                identifier,
                &entry(name),
                Some(&STANDARD.encode(private.bytes())),
            )?;
            Ok(Some(key))
        }
    }

    fn can_evaluate() -> bool {
        let context = unsafe { LAContext::new() };
        unsafe { context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) }.is_ok()
    }

    fn evaluate() -> Result<(), String> {
        let context = unsafe { LAContext::new() };
        let (sender, receiver) = mpsc::channel();
        let reply = RcBlock::new(move |success: Bool, _error: *mut NSError| {
            let _ = sender.send(success.as_bool());
        });
        unsafe {
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &NSString::from_str(PRESENCE_REASON),
                &reply,
            );
        }
        match receiver.recv() {
            Ok(true) => Ok(()),
            _ => Err("The presence check did not complete.".to_string()),
        }
    }

    fn is_enclave(key: &SecKey) -> bool {
        key.attributes()
            .find(unsafe { kSecAttrTokenID }.to_void())
            .is_some()
    }

    fn open(identifier: &str, name: &str) -> Result<Option<Key>, String> {
        let presence = name == PRESENCE;
        Ok(stored(identifier, name)?.map(|key| Key { key, presence }))
    }

    fn open_or_create(identifier: &str, name: &str) -> Result<Option<Key>, String> {
        if let Some(key) = open(identifier, name)? {
            return Ok(Some(key));
        }
        let _creating = CREATING.lock().map_err(|e| e.to_string())?;
        if let Some(key) = open(identifier, name)? {
            return Ok(Some(key));
        }
        let presence = name == PRESENCE;
        Ok(create(identifier, name, presence)?.map(|key| Key { key, presence }))
    }

    pub fn signing_key(identifier: &str) -> Result<Key, String> {
        open_or_create(identifier, SIGNING)?.ok_or_else(|| "No signing key.".to_string())
    }

    pub fn presence_key(identifier: &str) -> Result<Option<Key>, String> {
        open_or_create(identifier, PRESENCE)
    }

    pub fn find(identifier: &str, key_id: &str) -> Result<Key, String> {
        for name in [SIGNING, PRESENCE] {
            if let Some(key) = open(identifier, name)?
                && report_of(&key.point()?).key_id == key_id
            {
                return Ok(key);
            }
        }
        Err("This device has no such key.".to_string())
    }

    impl Key {
        pub fn point(&self) -> Result<PublicPoint, String> {
            let representation = self
                .key
                .public_key()
                .and_then(|public| public.external_representation())
                .ok_or("The public key is unavailable.")?;
            let bytes = representation.bytes();
            if bytes.len() != 65 || bytes[0] != 4 {
                return Err("The public key is not an uncompressed P-256 point.".to_string());
            }
            Ok(PublicPoint {
                x: bytes[1..33].to_vec(),
                y: bytes[33..].to_vec(),
            })
        }

        pub fn sign(&self, payload: &[u8]) -> Result<[u8; 64], String> {
            if self.presence && !is_enclave(&self.key) {
                evaluate()?;
            }
            let der = self
                .key
                .create_signature(Algorithm::ECDSASignatureMessageX962SHA256, payload)
                .map_err(|e| e.to_string())?;
            der_to_raw(&der)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod unsupported {
    use super::PublicPoint;

    pub struct Key;

    pub fn signing_key(_identifier: &str) -> Result<Key, String> {
        Err("unsupported".to_string())
    }

    pub fn presence_key(_identifier: &str) -> Result<Option<Key>, String> {
        Err("unsupported".to_string())
    }

    pub fn find(_identifier: &str, _key_id: &str) -> Result<Key, String> {
        Err("unsupported".to_string())
    }

    impl Key {
        pub fn point(&self) -> Result<PublicPoint, String> {
            Err("unsupported".to_string())
        }

        pub fn sign(&self, _payload: &[u8]) -> Result<[u8; 64], String> {
            Err("unsupported".to_string())
        }
    }
}
