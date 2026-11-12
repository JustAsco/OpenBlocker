//! The account-wide unlock password: Argon2id hashes and a brake on guessing.
//!
//! The idea is that someone you trust sets the password, so they can end a
//! password-locked block when you ask them. Only the hash is stored (in the
//! app's and the service's state).

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

pub const MIN_LEN: usize = 4;
/// After a wrong password, further attempts are refused for this long.
const WRONG_DELAY_MS: i64 = 3_000;

pub fn hash(password: &str) -> Result<String, String> {
    if password.chars().count() < MIN_LEN {
        return Err(format!("Use at least {MIN_LEN} characters."));
    }
    let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes()).map_err(|e| e.to_string())?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// Slows down guessing: one wrong password locks out further tries briefly.
#[derive(Default)]
pub struct Throttle {
    until: i64,
}

impl Throttle {
    /// Checks `password` against `hash` (None = no password set).
    pub fn check(&mut self, password: Option<&str>, hash: Option<&str>, now_ms: i64) -> Result<(), String> {
        if now_ms < self.until {
            return Err("Too many attempts. Wait a few seconds and try again.".into());
        }
        let Some(hash) = hash else {
            return Err("No password is set.".into());
        };
        if password.is_some_and(|p| verify(p, hash)) {
            Ok(())
        } else {
            self.until = now_ms + WRONG_DELAY_MS;
            Err("Wrong password.".into())
        }
    }
}

/// Validates a password change and returns the new hash (None = removed).
/// The current password is required whenever one is set.
pub fn change(throttle: &mut Throttle, current_hash: Option<&str>, current: Option<&str>, new: Option<&str>, now_ms: i64) -> Result<Option<String>, String> {
    if current_hash.is_some() {
        throttle.check(current, current_hash, now_ms)?;
    }
    new.map(hash).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_and_verifies() {
        let h = hash("hunter22").unwrap();
        assert!(h.starts_with("$argon2"));
        assert!(verify("hunter22", &h));
        assert!(!verify("hunter23", &h));
        assert!(hash("abc").is_err());
    }

    #[test]
    fn throttles_wrong_guesses() {
        let h = hash("secret").unwrap();
        let mut t = Throttle::default();
        assert!(t.check(Some("nope"), Some(&h), 0).is_err());
        // Even the right password is refused right after a wrong one.
        assert!(t.check(Some("secret"), Some(&h), 1_000).is_err());
        assert!(t.check(Some("secret"), Some(&h), 3_001).is_ok());
    }

    #[test]
    fn changing_needs_the_current_password() {
        let mut t = Throttle::default();
        let first = change(&mut t, None, None, Some("first"), 0).unwrap().unwrap();
        assert!(change(&mut t, Some(&first), Some("wrong"), Some("second"), 0).is_err());
        assert!(change(&mut t, Some(&first), Some("first"), None, 10_000).unwrap().is_none());
    }
}
