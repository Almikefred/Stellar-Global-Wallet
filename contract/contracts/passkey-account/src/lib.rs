#![no_std]

//! # passkey-account
//!
//! Soroban custom account whose signers are WebAuthn passkeys (secp256r1 /
//! P-256), issue #181. Users authorize transactions with Face ID, Touch ID,
//! Windows Hello or a security key instead of a seed phrase.
//!
//! ## How a signature is checked (`__check_auth`)
//! 1. The signer is looked up by its WebAuthn credential id.
//! 2. `client_data_json` must have `"type":"webauthn.get"` and a `challenge`
//!    equal to base64url(signature_payload). This binds the assertion to the
//!    exact Soroban auth entry (which already includes a nonce and an
//!    expiration ledger), so an assertion can't be reused for another entry.
//! 3. `authenticator_data` must have the User Present flag; admin signers
//!    must also have User Verified (biometric/PIN).
//! 4. If the authenticator reports a sign counter, it must strictly increase
//!    (cloned-key / replay detection on top of Soroban's nonce).
//! 5. `secp256r1_verify(pk, sha256(authenticator_data || sha256(client_data_json)), sig)`
//!    via the protocol 21 host function. `s` is normalized to low form
//!    first, because authenticators produce either form and the host only
//!    accepts low-S.
//!
//! ## Roles
//! * `Admin` signers may authorize anything, including calls on this account
//!   itself (`add_signer`, `remove_signer`) and contract deployment.
//! * `Session` signers may only authorize calls on *other* contracts and only
//!   until `expires_at` (ledger timestamp). They can never change signers.
//!
//! See `docs/design/passkey-signers.md` for the threat model.

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    Bytes, BytesN, Env, Symbol, Vec,
};

/// Max accepted `client_data_json` length. Real browsers send ~150-300 bytes.
pub const MAX_CLIENT_DATA_LEN: u32 = 1024;
/// `rpIdHash` (32) + flags (1) + signCount (4).
pub const MIN_AUTH_DATA_LEN: u32 = 37;
/// Extensions can make authenticator data longer; cap it to bound cost.
pub const MAX_AUTH_DATA_LEN: u32 = 512;
pub const MAX_CREDENTIAL_ID_LEN: u32 = 255;

const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;

const SIGNER_TTL_THRESHOLD: u32 = 17_280 * 7;
const SIGNER_TTL_EXTEND_TO: u32 = 17_280 * 30;

/// P-256 group order n, big-endian.
const P256_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84, 0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51,
];
/// floor(n / 2), big-endian.
const P256_HALF_N: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0x80, 0x00, 0x00, 0x00, 0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xDE, 0x73, 0x7D, 0x56, 0xD3, 0x8B, 0xCF, 0x42, 0x79, 0xDC, 0xE5, 0x61, 0x7E, 0x31, 0x92, 0xA8,
];

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignerRole {
    Admin,
    Session,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Signer {
    /// SEC1 uncompressed P-256 public key (0x04 || X || Y).
    pub public_key: BytesN<65>,
    pub role: SignerRole,
    /// Ledger timestamp after which the signer is rejected; 0 = never.
    /// Session signers must set it.
    pub expires_at: u64,
    /// Last authenticator sign counter seen (0 = authenticator doesn't count).
    pub counter: u32,
}

/// The signature `__check_auth` receives, built by the client from a
/// `navigator.credentials.get()` assertion (see `packages/sdk` passkey helpers).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WebAuthnSignature {
    /// Credential id (raw bytes, not base64).
    pub id: Bytes,
    pub authenticator_data: Bytes,
    pub client_data_json: Bytes,
    /// Compact r || s (the client converts the DER signature).
    pub signature: BytesN<64>,
}

#[contracttype]
pub enum DataKey {
    Signer(Bytes),
    AdminCount,
}

// 3001+ namespace: globe-wallet uses 1001+, token-wrapper 2001+.
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum PasskeyError {
    AlreadyInitialized = 3001,
    NotInitialized = 3002,
    SignerNotFound = 3003,
    SignerAlreadyExists = 3004,
    InvalidPublicKey = 3005,
    InvalidCredentialId = 3006,
    InvalidAuthenticatorData = 3007,
    InvalidClientData = 3008,
    ChallengeMismatch = 3009,
    UserNotPresent = 3010,
    UserNotVerified = 3011,
    CounterNotIncreased = 3012,
    SignerExpired = 3013,
    /// A session signer tried to authorize an admin-only context.
    AdminRequired = 3014,
    /// Session signers need a non-zero `expires_at` in the future.
    InvalidExpiry = 3015,
    /// Removing this signer would leave the account with no admin.
    LastAdmin = 3016,
}

#[contract]
pub struct PasskeyAccount;

#[contractimpl]
impl PasskeyAccount {
    /// Register the first admin passkey. Callable once; deploy and call it in
    /// the same transaction so nobody can front-run the first signer.
    pub fn init(env: Env, id: Bytes, public_key: BytesN<65>) -> Result<(), PasskeyError> {
        if env.storage().instance().has(&DataKey::AdminCount) {
            return Err(PasskeyError::AlreadyInitialized);
        }
        Self::put_signer(&env, &id, &public_key, SignerRole::Admin, 0)?;
        env.storage().instance().set(&DataKey::AdminCount, &1u32);
        Ok(())
    }

    /// Add a signer. Needs this account's own auth, i.e. an admin passkey.
    pub fn add_signer(
        env: Env,
        id: Bytes,
        public_key: BytesN<65>,
        role: SignerRole,
        expires_at: u64,
    ) -> Result<(), PasskeyError> {
        Self::require_initialized(&env)?;
        env.current_contract_address().require_auth();
        if role == SignerRole::Session && expires_at <= env.ledger().timestamp() {
            return Err(PasskeyError::InvalidExpiry);
        }
        Self::put_signer(&env, &id, &public_key, role, expires_at)?;
        if role == SignerRole::Admin {
            let n = Self::admin_count(&env);
            env.storage().instance().set(&DataKey::AdminCount, &(n + 1));
        }
        Ok(())
    }

    /// Remove a signer. Needs an admin passkey. The last admin can't be removed.
    pub fn remove_signer(env: Env, id: Bytes) -> Result<(), PasskeyError> {
        Self::require_initialized(&env)?;
        env.current_contract_address().require_auth();
        let key = DataKey::Signer(id.clone());
        let signer: Signer = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PasskeyError::SignerNotFound)?;
        if signer.role == SignerRole::Admin {
            let n = Self::admin_count(&env);
            if n <= 1 {
                return Err(PasskeyError::LastAdmin);
            }
            env.storage().instance().set(&DataKey::AdminCount, &(n - 1));
        }
        env.storage().persistent().remove(&key);
        env.events()
            .publish((Symbol::new(&env, "signer"), Symbol::new(&env, "removed")), id);
        Ok(())
    }

    pub fn get_signer(env: Env, id: Bytes) -> Option<Signer> {
        env.storage().persistent().get(&DataKey::Signer(id))
    }

    pub fn admin_count(env: &Env) -> u32 {
        env.storage().instance().get(&DataKey::AdminCount).unwrap_or(0)
    }

    fn require_initialized(env: &Env) -> Result<(), PasskeyError> {
        if env.storage().instance().has(&DataKey::AdminCount) {
            Ok(())
        } else {
            Err(PasskeyError::NotInitialized)
        }
    }

    fn put_signer(
        env: &Env,
        id: &Bytes,
        public_key: &BytesN<65>,
        role: SignerRole,
        expires_at: u64,
    ) -> Result<(), PasskeyError> {
        if id.is_empty() || id.len() > MAX_CREDENTIAL_ID_LEN {
            return Err(PasskeyError::InvalidCredentialId);
        }
        if public_key.get(0) != Some(0x04) {
            return Err(PasskeyError::InvalidPublicKey);
        }
        let key = DataKey::Signer(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(PasskeyError::SignerAlreadyExists);
        }
        let signer = Signer {
            public_key: public_key.clone(),
            role,
            expires_at,
            counter: 0,
        };
        env.storage().persistent().set(&key, &signer);
        env.storage()
            .persistent()
            .extend_ttl(&key, SIGNER_TTL_THRESHOLD, SIGNER_TTL_EXTEND_TO);
        env.events().publish(
            (Symbol::new(env, "signer"), Symbol::new(env, "added")),
            (id.clone(), role, expires_at),
        );
        Ok(())
    }
}

#[contractimpl]
impl CustomAccountInterface for PasskeyAccount {
    type Signature = WebAuthnSignature;
    type Error = PasskeyError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: WebAuthnSignature,
        auth_contexts: Vec<Context>,
    ) -> Result<(), PasskeyError> {
        let key = DataKey::Signer(signature.id.clone());
        let mut signer: Signer = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PasskeyError::SignerNotFound)?;

        // Role and expiry.
        if signer.expires_at != 0 && env.ledger().timestamp() >= signer.expires_at {
            return Err(PasskeyError::SignerExpired);
        }
        if signer.role != SignerRole::Admin {
            let me = env.current_contract_address();
            for ctx in auth_contexts.iter() {
                match ctx {
                    Context::Contract(c) if c.contract != me => {}
                    _ => return Err(PasskeyError::AdminRequired),
                }
            }
        }

        // Authenticator data: flags and sign counter.
        let ad_len = signature.authenticator_data.len();
        if !(MIN_AUTH_DATA_LEN..=MAX_AUTH_DATA_LEN).contains(&ad_len) {
            return Err(PasskeyError::InvalidAuthenticatorData);
        }
        let flags = signature.authenticator_data.get(32).unwrap_or(0);
        if flags & FLAG_USER_PRESENT == 0 {
            return Err(PasskeyError::UserNotPresent);
        }
        if signer.role == SignerRole::Admin && flags & FLAG_USER_VERIFIED == 0 {
            return Err(PasskeyError::UserNotVerified);
        }
        let mut counter: u32 = 0;
        for i in 33..37 {
            counter = (counter << 8) | signature.authenticator_data.get(i).unwrap_or(0) as u32;
        }
        if counter != 0 || signer.counter != 0 {
            if counter <= signer.counter {
                return Err(PasskeyError::CounterNotIncreased);
            }
        }

        // Client data: type and challenge binding.
        check_client_data(&signature.client_data_json, &signature_payload.to_array())?;

        // Signature over authenticator_data || sha256(client_data_json).
        let mut msg = signature.authenticator_data.clone();
        msg.append(&Bytes::from(env.crypto().sha256(&signature.client_data_json)));
        let digest = env.crypto().sha256(&msg);
        let sig = normalize_s(&env, &signature.signature);
        // Traps (failing auth) if the signature does not verify.
        env.crypto().secp256r1_verify(&signer.public_key, &digest, &sig);

        if counter != signer.counter {
            signer.counter = counter;
            env.storage().persistent().set(&key, &signer);
        }
        env.storage()
            .persistent()
            .extend_ttl(&key, SIGNER_TTL_THRESHOLD, SIGNER_TTL_EXTEND_TO);
        Ok(())
    }
}

/// Checks `"type":"webauthn.get"` and that `"challenge"` is
/// base64url(no padding) of the 32-byte signature payload.
pub fn check_client_data(client_data_json: &Bytes, payload: &[u8; 32]) -> Result<(), PasskeyError> {
    let len = client_data_json.len();
    if len == 0 || len > MAX_CLIENT_DATA_LEN {
        return Err(PasskeyError::InvalidClientData);
    }
    let mut buf = [0u8; MAX_CLIENT_DATA_LEN as usize];
    let json = &mut buf[..len as usize];
    client_data_json.copy_into_slice(json);

    if find(json, b"\"type\":\"webauthn.get\"").is_none() {
        return Err(PasskeyError::InvalidClientData);
    }
    let marker = b"\"challenge\":\"";
    let start = find(json, marker).ok_or(PasskeyError::InvalidClientData)? + marker.len();
    let expected = base64url_32(payload);
    let end = start + expected.len();
    if end >= json.len() || json[end] != b'"' {
        return Err(PasskeyError::ChallengeMismatch);
    }
    if json[start..end] != expected[..] {
        return Err(PasskeyError::ChallengeMismatch);
    }
    Ok(())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// base64url without padding of 32 bytes (always 43 chars).
pub fn base64url_32(input: &[u8; 32]) -> [u8; 43] {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = [0u8; 43];
    let mut o = 0;
    let mut i = 0;
    while i + 3 <= 32 {
        let n = (input[i] as u32) << 16 | (input[i + 1] as u32) << 8 | input[i + 2] as u32;
        out[o] = ALPHABET[(n >> 18) as usize & 63];
        out[o + 1] = ALPHABET[(n >> 12) as usize & 63];
        out[o + 2] = ALPHABET[(n >> 6) as usize & 63];
        out[o + 3] = ALPHABET[n as usize & 63];
        o += 4;
        i += 3;
    }
    // 32 = 30 + 2 remaining bytes → 3 chars.
    let n = (input[30] as u32) << 16 | (input[31] as u32) << 8;
    out[o] = ALPHABET[(n >> 18) as usize & 63];
    out[o + 1] = ALPHABET[(n >> 12) as usize & 63];
    out[o + 2] = ALPHABET[(n >> 6) as usize & 63];
    out
}

/// Returns r || s with s replaced by n - s when s > n/2 (low-S form).
pub fn normalize_s(env: &Env, sig: &BytesN<64>) -> BytesN<64> {
    let mut raw = sig.to_array();
    let mut s = [0u8; 32];
    s.copy_from_slice(&raw[32..]);
    if s > P256_HALF_N {
        // Big-endian 256-bit subtraction n - s (s < n for any valid sig).
        let mut borrow: i16 = 0;
        for i in (0..32).rev() {
            let mut d = P256_N[i] as i16 - s[i] as i16 - borrow;
            if d < 0 {
                d += 256;
                borrow = 1;
            } else {
                borrow = 0;
            }
            raw[32 + i] = d as u8;
        }
    }
    BytesN::from_array(env, &raw)
}

