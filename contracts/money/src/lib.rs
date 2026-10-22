//! Cross-layer money policy shared by every RemitLend contract.
//!
//! This crate is the single place where stroop-denominated `i128` amounts are
//! divided, rounded, or split pro-rata. Every contract that touches a stroop
//! quantity must route the conversion through [`round_div`] or
//! [`split_pro_rata`] rather than using a bare `/` — that is what keeps this
//! crate's semantics, the backend's `decimal.ts`, and the frontend's
//! generated formatter in lock-step (see `money-policy.json` at the repo
//! root and `scripts/gen-money.ts`).
//!
//! # Adding a new asset precision
//!
//! Asset precisions are part of the shared money policy, not of any single
//! contract. To add one:
//!
//! 1. Add the asset (its code, decimals, and minimum unit) to
//!    `money-policy.json` at the repo root.
//! 2. Regenerate [`policy`] by running `scripts/gen-money.ts`; never edit the
//!    generated constants by hand.
//! 3. Extend `vectors/money-policy.v1.json` with conformance cases covering
//!    the new precision: zero, one minor unit, half-way rounding, the maximum
//!    representable value, and invalid sign/scale inputs. Bump the vector
//!    version if the schema changes.
//! 4. Run the conformance suite (`cargo test -p money conformance` and the
//!    backend's matching suite). Both implementations consume the same
//!    versioned vector file, so a divergence fails CI with the offending
//!    vector `id` and package name.
#![no_std]

pub mod policy;

use soroban_sdk::{contracterror, Env, Vec};

/// Number of stroops in one whole unit (`10^7`), re-exported from
/// [`policy::STROOP_SCALE`] for ergonomic access at the crate root.
pub const STROOP_SCALE: i128 = policy::STROOP_SCALE;

/// Rounding strategy applied by [`round_div`] when a division has a nonzero
/// remainder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundingMode {
    /// Round to the nearest value; ties round to the nearest even quotient
    /// (banker's rounding). This is the default settlement mode used by the
    /// backend and contracts alike, chosen because it does not bias
    /// accumulated rounding error in either direction over many operations.
    HalfEven,
    /// Round to the nearest value; ties round away from zero.
    HalfUp,
    /// Always round toward negative infinity.
    Floor,
    /// Always round toward positive infinity.
    Ceil,
}

/// Errors produced by the money-policy helpers.
#[contracterror]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum MathError {
    /// An intermediate or final value overflowed `i128`.
    Overflow = 1,
    /// The denominator supplied to a division was zero.
    DivByZero = 2,
    /// A post-condition invariant (e.g. pro-rata parts summing to the
    /// total) failed to hold, indicating a drift between layers.
    DriftDetected = 3,
    /// An operand was negative, or a result fell outside its allowed bounds.
    OutOfRange = 4,
}

/// Divide `num` by `den`, applying `mode` to any remainder.
///
/// This is the *only* sanctioned way to divide a stroop quantity in this
/// codebase. All intermediate arithmetic is overflow-checked.
pub fn round_div(num: i128, den: i128, mode: RoundingMode) -> Result<i128, MathError> {
    if den == 0 {
        return Err(MathError::DivByZero);
    }

    // Normalize so `den` is always positive; fold its sign into `num`.
    let (num, den) = if den < 0 {
        (
            num.checked_neg().ok_or(MathError::Overflow)?,
            den.checked_neg().ok_or(MathError::Overflow)?,
        )
    } else {
        (num, den)
    };

    let quotient = num / den;
    let remainder = num % den;

    if remainder == 0 {
        return Ok(quotient);
    }

    // `remainder` has the same sign as `num` (Rust's truncating division
    // semantics). `abs_remainder` lets each rounding mode reason about
    // magnitude only; the sign is reapplied below.
    let remainder_is_negative = remainder < 0;
    let abs_remainder = remainder.checked_abs().ok_or(MathError::Overflow)?;

    let round_away_from_zero = match mode {
        RoundingMode::Floor => remainder_is_negative,
        RoundingMode::Ceil => !remainder_is_negative,
        RoundingMode::HalfUp => abs_remainder.checked_mul(2).ok_or(MathError::Overflow)? >= den,
        RoundingMode::HalfEven => {
            let doubled = abs_remainder.checked_mul(2).ok_or(MathError::Overflow)?;
            match doubled.cmp(&den) {
                core::cmp::Ordering::Greater => true,
                core::cmp::Ordering::Less => false,
                // Exact tie: round to even.
                core::cmp::Ordering::Equal => quotient % 2 != 0,
            }
        }
    };

    if round_away_from_zero {
        if remainder_is_negative {
            quotient.checked_sub(1).ok_or(MathError::Overflow)
        } else {
            quotient.checked_add(1).ok_or(MathError::Overflow)
        }
    } else {
        Ok(quotient)
    }
}

/// Split `total` among `weights` using the largest-remainder method so the
/// returned parts sum *exactly* to `total` (no dust is created or lost),
/// while staying as proportional to each weight as integer stroops allow.
///
/// Each part is first assigned `floor(total * weight / sum(weights))`. The
/// leftover units (`total - sum(floors)`) are then distributed one-by-one to
/// the entries with the largest fractional remainder, breaking ties by
/// index (lowest index first) for determinism.
///
/// `total` and every weight must be non-negative, and at least one weight
/// must be nonzero (unless `total` is zero, in which case every part is
/// zero).
pub fn split_pro_rata(env: &Env, total: i128, weights: &Vec<i128>) -> Result<Vec<i128>, MathError> {
    let n = weights.len();
    let mut parts = Vec::new(env);
    if n == 0 {
        return if total == 0 {
            Ok(parts)
        } else {
            Err(MathError::DriftDetected)
        };
    }

    let mut weight_sum: i128 = 0;
    for w in weights.iter() {
        if w < 0 {
            return Err(MathError::DriftDetected);
        }
        weight_sum = weight_sum.checked_add(w).ok_or(MathError::Overflow)?;
    }

    if weight_sum == 0 {
        for _ in 0..n {
            parts.push_back(0);
        }
        return if total == 0 {
            Ok(parts)
        } else {
            Err(MathError::DriftDetected)
        };
    }

    // First pass: floor allocation + remainder (scaled by weight_sum so we
    // can compare remainders across entries without floating point).
    let mut remainders: Vec<(u32, i128)> = Vec::new(env);
    let mut allocated: i128 = 0;
    for (idx, w) in weights.iter().enumerate() {
        let numerator = total.checked_mul(w).ok_or(MathError::Overflow)?;
        let floor_part = numerator / weight_sum;
        let remainder = numerator % weight_sum;
        parts.push_back(floor_part);
        allocated = allocated
            .checked_add(floor_part)
            .ok_or(MathError::Overflow)?;
        remainders.push_back((idx as u32, remainder));
    }

    let mut leftover = total.checked_sub(allocated).ok_or(MathError::Overflow)?;
    if leftover < 0 {
        return Err(MathError::DriftDetected);
    }

    // Selection sort descending by remainder (n is expected to be small —
    // pool participants / loan tranches — so O(n^2) is fine and avoids
    // pulling in an allocator-backed sort).
    let remainder_count = remainders.len();
    let mut sorted: Vec<(u32, i128)> = Vec::new(env);
    let mut used = Vec::new(env);
    for _ in 0..remainder_count {
        used.push_back(false);
    }
    for _ in 0..remainder_count {
        let mut best_idx: Option<u32> = None;
        let mut best_remainder: i128 = -1;
        for i in 0..remainder_count {
            if used.get(i).unwrap() {
                continue;
            }
            let (orig_idx, rem) = remainders.get(i).unwrap();
            match rem.cmp(&best_remainder) {
                core::cmp::Ordering::Greater => {
                    best_remainder = rem;
                    best_idx = Some(i);
                }
                core::cmp::Ordering::Equal => {
                    if let Some(cur_best) = best_idx {
                        let (cur_orig, _) = remainders.get(cur_best).unwrap();
                        if orig_idx < cur_orig {
                            best_idx = Some(i);
                        }
                    }
                }
                core::cmp::Ordering::Less => {}
            }
        }
        let chosen = best_idx.expect("remainder_count entries remain");
        used.set(chosen, true);
        sorted.push_back(remainders.get(chosen).unwrap());
    }

    let mut i = 0u32;
    while leftover > 0 {
        let (orig_idx, _) = sorted.get(i).unwrap();
        let current = parts.get(orig_idx).unwrap();
        parts.set(orig_idx, current.checked_add(1).ok_or(MathError::Overflow)?);
        leftover -= 1;
        i += 1;
        if i >= remainder_count {
            i = 0;
        }
    }

    Ok(parts)
}

/// Multiply `a` by `b`, then divide by `den`, applying `mode` to any remainder.
///
/// The product is overflow-checked before rounding, so a wrapped intermediate
/// can never reach settlement. Prefer this over a bare `a * b / den`.
pub fn mul_div(a: i128, b: i128, den: i128, mode: RoundingMode) -> Result<i128, MathError> {
    let prod = a.checked_mul(b).ok_or(MathError::Overflow)?;
    round_div(prod, den, mode)
}

/// Add two non-negative stroop amounts, rejecting any sum above `max`.
///
/// Negative operands or a negative `max` are rejected outright so that bad
/// input can never be credited to a balance.
pub fn bounded_add(a: i128, b: i128, max: i128) -> Result<i128, MathError> {
    if a < 0 || b < 0 || max < 0 {
        return Err(MathError::OutOfRange);
    }
    let sum = a.checked_add(b).ok_or(MathError::Overflow)?;
    if sum > max {
        return Err(MathError::OutOfRange);
    }
    Ok(sum)
}

/// Subtract `b` from `a`, rejecting negative operands and any result below zero.
pub fn bounded_sub(a: i128, b: i128) -> Result<i128, MathError> {
    if a < 0 || b < 0 {
        return Err(MathError::OutOfRange);
    }
    let diff = a.checked_sub(b).ok_or(MathError::Overflow)?;
    if diff < 0 {
        return Err(MathError::OutOfRange);
    }
    Ok(diff)
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    fn v(env: &Env, xs: &[i128]) -> Vec<i128> {
        Vec::from_slice(env, xs)
    }

    #[test]
    fn round_div_floor() {
        assert_eq!(round_div(7, 2, RoundingMode::Floor), Ok(3));
        assert_eq!(round_div(-7, 2, RoundingMode::Floor), Ok(-4));
        assert_eq!(round_div(6, 2, RoundingMode::Floor), Ok(3));
    }

    #[test]
    fn round_div_ceil() {
        assert_eq!(round_div(7, 2, RoundingMode::Ceil), Ok(4));
        assert_eq!(round_div(-7, 2, RoundingMode::Ceil), Ok(-3));
        assert_eq!(round_div(6, 2, RoundingMode::Ceil), Ok(3));
    }

    #[test]
    fn round_div_half_up() {
        assert_eq!(round_div(5, 2, RoundingMode::HalfUp), Ok(3)); // 2.5 -> 3
        assert_eq!(round_div(-5, 2, RoundingMode::HalfUp), Ok(-3));
        assert_eq!(round_div(7, 2, RoundingMode::HalfUp), Ok(4)); // 3.5 -> 4
        assert_eq!(round_div(1, 4, RoundingMode::HalfUp), Ok(0)); // 0.25 -> 0
    }

    #[test]
    fn round_div_half_even() {
        assert_eq!(round_div(5, 2, RoundingMode::HalfEven), Ok(2)); // 2.5 -> 2 (even)
        assert_eq!(round_div(7, 2, RoundingMode::HalfEven), Ok(4)); // 3.5 -> 4 (even)
        assert_eq!(round_div(9, 2, RoundingMode::HalfEven), Ok(4)); // 4.5 -> 4 (even)
        assert_eq!(round_div(3, 2, RoundingMode::HalfEven), Ok(2)); // 1.5 -> 2 (even)
        assert_eq!(round_div(-5, 2, RoundingMode::HalfEven), Ok(-2));
    }

    #[test]
    fn round_div_div_by_zero() {
        assert_eq!(
            round_div(5, 0, RoundingMode::HalfEven),
            Err(MathError::DivByZero)
        );
    }

    #[test]
    fn split_pro_rata_sums_to_total() {
        let env = Env::default();
        let cases: &[(i128, &[i128])] = &[
            (100, &[1, 1, 1]),
            (101, &[1, 1, 1]),
            (1_000_000_007, &[3, 5, 7, 11]),
            (7, &[1, 1, 1, 1, 1, 1, 1]),
            (0, &[1, 2, 3]),
            (1, &[1]),
            (10_000_000, &[333, 333, 334]),
        ];
        for (total, weights) in cases {
            let w = v(&env, weights);
            let parts = split_pro_rata(&env, *total, &w).unwrap();
            let sum: i128 = parts.iter().sum();
            assert_eq!(sum, *total, "parts must sum exactly to total");
            assert_eq!(parts.len(), w.len());
        }
    }

    #[test]
    fn split_pro_rata_randomized_sum_invariance() {
        use rand::rngs::StdRng;
        use rand::{Rng, SeedableRng};

        let mut rng = StdRng::seed_from_u64(0x1378_1378_1378_1378);

        for _ in 0..1_000 {
            // Fresh env per iteration: the test host meters a budget per
            // `Env`, and reusing one across thousands of Vec operations
            // would exceed it even though each individual allocation is tiny.
            let env = Env::default();
            let n = rng.gen_range(1..=12);
            let total: i128 = rng.gen_range(0..=1_000_000_000_000i128);
            let weights: Vec<i128> = {
                let mut w = Vec::new(&env);
                for _ in 0..n {
                    w.push_back(rng.gen_range(0..=1_000_000i128));
                }
                w
            };
            // Ensure at least one nonzero weight so the case is well-formed.
            let weight_sum: i128 = weights.iter().sum();
            if weight_sum == 0 {
                continue;
            }
            let parts = split_pro_rata(&env, total, &weights).unwrap();
            let sum: i128 = parts.iter().sum();
            assert_eq!(sum, total);
            for p in parts.iter() {
                assert!(p >= 0, "no negative allocation");
            }
        }
    }

    #[test]
    fn split_pro_rata_zero_weights_error_on_nonzero_total() {
        let env = Env::default();
        let w = v(&env, &[0, 0, 0]);
        assert_eq!(split_pro_rata(&env, 100, &w), Err(MathError::DriftDetected));
        assert_eq!(split_pro_rata(&env, 0, &w), Ok(v(&env, &[0, 0, 0])));
    }
}

/// Cross-layer conformance suite.
///
/// The canonical, versioned vector set lives at
/// `vectors/money-policy.v1.json` and is consumed verbatim by both this crate
/// and `backend/src/money/decimal.ts`. Nothing here is copied into a
/// per-language fixture: if the two implementations diverge, the same vector
/// fails on both sides and CI reports the vector `id` plus the package name.
#[cfg(test)]
mod conformance {
    extern crate std;

    use super::*;
    use std::string::String;
    use std::vec::Vec as StdVec;

    /// The single source of truth for money-policy conformance vectors.
    const VECTORS_JSON: &str = include_str!("../../../vectors/money-policy.v1.json");

    /// Package name reported in failure messages so CI output is actionable.
    const PACKAGE: &str = "contracts/money";

    // ---------------------------------------------------------------------
    // Minimal JSON reader.
    //
    // The crate is `no_std`; pulling `serde_json` in as a dev-dependency just
    // for tests would drag a large dependency tree into the workspace. The
    // vector schema is small and fixed, so a tiny hand-rolled parser keeps the
    // build lean while still validating structure strictly.
    // ---------------------------------------------------------------------

    #[derive(Debug, Clone, PartialEq)]
    enum Json {
        Null,
        Bool(bool),
        Num(i128),
        Str(String),
        Arr(StdVec<Json>),
        Obj(StdVec<(String, Json)>),
    }

    impl Json {
        fn get(&self, key: &str) -> Option<&Json> {
            match self {
                Json::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
                _ => None,
            }
        }

        fn as_i128(&self) -> Option<i128> {
            match self {
                Json::Num(n) => Some(*n),
                _ => None,
            }
        }

        fn as_str(&self) -> Option<&str> {
            match self {
                Json::Str(s) => Some(s.as_str()),
                _ => None,
            }
        }

        fn as_arr(&self) -> Option<&[Json]> {
            match self {
                Json::Arr(items) => Some(items.as_slice()),
                _ => None,
            }
        }
    }

    struct Parser<'a> {
        bytes: &'a [u8],
        pos: usize,
    }

    impl<'a> Parser<'a> {
        fn new(input: &'a str) -> Self {
            Parser {
                bytes: input.as_bytes(),
                pos: 0,
            }
        }

        fn skip_ws(&mut self) {
            while let Some(&b) = self.bytes.get(self.pos) {
                if b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' {
                    self.pos += 1;
                } else {
                    break;
                }
            }
        }

        fn peek(&self) -> Option<u8> {
            self.bytes.get(self.pos).copied()
        }

        fn expect(&mut self, byte: u8) -> Result<(), String> {
            if self.peek() == Some(byte) {
                self.pos += 1;
                Ok(())
            } else {
                Err(std::format!(
                    "expected `{}` at byte {}",
                    byte as char,
                    self.pos
                ))
            }
        }

        fn parse_value(&mut self) -> Result<Json, String> {
            self.skip_ws();
            match self.peek() {
                Some(b'{') => self.parse_object(),
                Some(b'[') => self.parse_array(),
                Some(b'"') => Ok(Json::Str(self.parse_string()?)),
                Some(b't') => {
                    self.expect_literal("true")?;
                    Ok(Json::Bool(true))
                }
                Some(b'f') => {
                    self.expect_literal("false")?;
                    Ok(Json::Bool(false))
                }
                Some(b'n') => {
                    self.expect_literal("null")?;
                    Ok(Json::Null)
                }
                Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
                other => Err(std::format!(
                    "unexpected byte {:?} at {}",
                    other,
                    self.pos
                )),
            }
        }

        fn expect_literal(&mut self, lit: &str) -> Result<(), String> {
            if self.bytes[self.pos..].starts_with(lit.as_bytes()) {
                self.pos += lit.len();
                Ok(())
            } else {
                Err(std::format!("expected `{}` at byte {}", lit, self.pos))
            }
        }

        fn parse_object(&mut self) -> Result<Json, String> {
            self.expect(b'{')?;
            let mut entries = StdVec::new();
            self.skip_ws();
            if self.peek() == Some(b'}') {
                self.pos += 1;
                return Ok(Json::Obj(entries));
            }
            loop {
                self.skip_ws();
                let key = self.parse_string()?;
                self.skip_ws();
                self.expect(b':')?;
                let value = self.parse_value()?;
                entries.push((key, value));
                self.skip_ws();
                match self.peek() {
                    Some(b',') => self.pos += 1,
                    Some(b'}') => {
                        self.pos += 1;
                        return Ok(Json::Obj(entries));
                    }
                    _ => return Err(std::format!("expected `,` or `}}` at {}", self.pos)),
                }
            }
        }

        fn parse_array(&mut self) -> Result<Json, String> {
            self.expect(b'[')?;
            let mut items = StdVec::new();
            self.skip_ws();
            if self.peek() == Some(b']') {
                self.pos += 1;
                return Ok(Json::Arr(items));
            }
            loop {
                items.push(self.parse_value()?);
                self.skip_ws();
                match self.peek() {
                    Some(b',') => self.pos += 1,
                    Some(b']') => {
                        self.pos += 1;
                        return Ok(Json::Arr(items));
                    }
                    _ => return Err(std::format!("expected `,` or `]` at {}", self.pos)),
                }
            }
        }

        fn parse_string(&mut self) -> Result<String, String> {
            self.expect(b'"')?;
            let mut out = String::new();
            loop {
                let b = self
                    .peek()
                    .ok_or_else(|| String::from("unterminated string"))?;
                self.pos += 1;
                match b {
                    b'"' => return Ok(out),
                    b'\\' => {
                        let esc = self
                            .peek()
                            .ok_or_else(|| String::from("unterminated escape"))?;
                        self.pos += 1;
                        match esc {
                            b'"' => out.push('"'),
                            b'\\' => out.push('\\'),
                            b'/' => out.push('/'),
                            b'n' => out.push('\n'),
                            b't' => out.push('\t'),
                            b'r' => out.push('\r'),
                            b'b' => out.push('\u{0008}'),
                            b'f' => out.push('\u{000C}'),
                            b'u' => {
                                let mut code: u32 = 0;
                                for _ in 0..4 {
                                    let h = self
                                        .peek()
                                        .ok_or_else(|| String::from("truncated \\u escape"))?;
                                    self.pos += 1;
                                    let digit = match h {
                                        b'0'..=b'9' => (h - b'0') as u32,
                                        b'a'..=b'f' => (h - b'a' + 10) as u32,
                                        b'A'..=b'F' => (h - b'A' + 10) as u32,
                                        _ => return Err(String::from("invalid \\u escape")),
                                    };
                                    code = code * 16 + digit;
                                }
                                out.push(
                                    char::from_u32(code)
                                        .ok_or_else(|| String::from("invalid code point"))?,
                                );
                            }
                            _ => return Err(String::from("invalid escape")),
                        }
                    }
                    _ => out.push(b as char),
                }
            }
        }

        fn parse_number(&mut self) -> Result<Json, String> {
            let start = self.pos;
            if self.peek() == Some(b'-') {
                self.pos += 1;
            }
            while let Some(b'0'..=b'9') = self.peek() {
                self.pos += 1;
            }
            // Reject fractional/exponent forms: every money-policy vector is
            // an integer stroop quantity, and silently truncating would hide
            // a fixture bug.
            if let Some(b'.') | Some(b'e') | Some(b'E') = self.peek() {
                return Err(std::format!(
                    "non-integer number at byte {} (money vectors must be integers)",
                    start
                ));
            }
            let text = std::str::from_utf8(&self.bytes[start..self.pos])
                .map_err(|_| String::from("invalid utf8 in number"))?;
            text.parse::<i128>()
                .map(Json::Num)
                .map_err(|_| std::format!("number out of i128 range: {}", text))
        }
    }

    fn parse_vectors() -> Json {
        let mut parser = Parser::new(VECTORS_JSON);
        let value = parser
            .parse_value()
            .unwrap_or_else(|e| panic!("[{}] failed to parse vectors: {}", PACKAGE, e));
        parser.skip_ws();
        assert_eq!(
            parser.pos,
            VECTORS_JSON.len(),
            "[{}] trailing data after vector document",
            PACKAGE
        );
        value
    }

    // ---------------------------------------------------------------------
    // Vector model.
    // ---------------------------------------------------------------------

    fn rounding_mode(name: &str) -> RoundingMode {
        match name {
            "half_even" => RoundingMode::HalfEven,
            "half_up" => RoundingMode::HalfUp,
            "floor" => RoundingMode::Floor,
            "ceil" => RoundingMode::Ceil,
            other => panic!("[{}] unknown rounding mode `{}`", PACKAGE, other),
        }
    }

    /// Decode an expected result: either an integer or an error name.
    fn expected_result(value: &Json) -> Result<i128, MathError> {
        match value {
            Json::Num(n) => Ok(*n),
            Json::Str(name) => Err(match name.as_str() {
                "overflow" => MathError::Overflow,
                "div_by_zero" => MathError::DivByZero,
                "drift_detected" => MathError::DriftDetected,
                "out_of_range" => MathError::OutOfRange,
                other => panic!("[{}] unknown expected error `{}`", PACKAGE, other),
            }),
            other => panic!("[{}] malformed expected result: {:?}", PACKAGE, other),
        }
    }

    fn field<'a>(vector: &'a Json, key: &str) -> &'a Json {
        vector.get(key).unwrap_or_else(|| {
            panic!(
                "[{}] vector `{}` missing field `{}`",
                PACKAGE,
                vector_id(vector),
                key
            )
        })
    }

    fn vector_id(vector: &Json) -> &str {
        vector
            .get("id")
            .and_then(Json::as_str)
            .unwrap_or("<missing id>")
    }

    fn int_field(vector: &Json, key: &str) -> i128 {
        field(vector, key).as_i128().unwrap_or_else(|| {
            panic!(
                "[{}] vector `{}` field `{}` must be an integer",
                PACKAGE,
                vector_id(vector),
                key
            )
        })
    }

    fn int_array_field(vector: &Json, key: &str) -> StdVec<i128> {
        field(vector, key)
            .as_arr()
            .unwrap_or_else(|| {
                panic!(
                    "[{}] vector `{}` field `{}` must be an array",
                    PACKAGE,
                    vector_id(vector),
                    key
                )
            })
            .iter()
            .map(|item| {
                item.as_i128().unwrap_or_else(|| {
                    panic!(
                        "[{}] vector `{}` field `{}` must contain integers",
                        PACKAGE,
                        vector_id(vector),
                        key
                    )
                })
            })
            .collect()
    }

    fn fail<T: std::fmt::Debug>(vector: &Json, op: &str, expected: &T, actual: &T) -> ! {
        panic!(
            "[{}] conformance mismatch: vector `{}` op `{}`: expected {:?}, got {:?}",
            PACKAGE,
            vector_id(vector),
            op,
            expected,
            actual
        )
    }

    // ---------------------------------------------------------------------
    // Tests.
    // ---------------------------------------------------------------------

    #[test]
    fn vectors_are_versioned_and_well_formed() {
        let doc = parse_vectors();
        let version = doc
            .get("version")
            .and_then(Json::as_i128)
            .unwrap_or_else(|| panic!("[{}] vector document missing integer `version`", PACKAGE));
        assert_eq!(version, 1, "[{}] unexpected vector version", PACKAGE);

        let vectors = doc
            .get("vectors")
            .and_then(Json::as_arr)
            .unwrap_or_else(|| panic!("[{}] vector document missing `vectors` array", PACKAGE));
        assert!(!vectors.is_empty(), "[{}] vector set is empty", PACKAGE);

        // Every vector must carry a unique id and a known op so a failure can
        // be minimized to a single line of CI output.
        let mut seen: StdVec<&str> = StdVec::new();
        for vector in vectors {
            let id = vector_id(vector);
            assert!(
                !seen.contains(&id),
                "[{}] duplicate vector id `{}`",
                PACKAGE,
                id
            );
            seen.push(id);
            let op = field(vector, "op").as_str().unwrap_or_else(|| {
                panic!("[{}] vector `{}` op must be a string", PACKAGE, id)
            });
            assert!(
                matches!(
                    op,
                    "round_div"
                        | "mul_div"
                        | "bounded_add"
                        | "bounded_sub"
                        | "split_pro_rata"
                        | "asset_precision"
                ),
                "[{}] vector `{}` has unknown op `{}`",
                PACKAGE,
                id,
                op
            );
        }
    }

    #[test]
    fn conformance_round_div() {
        let doc = parse_vectors();
        for vector in doc.get("vectors").and_then(Json::as_arr).unwrap() {
            if field(vector, "op").as_str() != Some("round_div") {
                continue;
            }
            let num = int_field(vector, "num");
            let den = int_field(vector, "den");
            let mode = rounding_mode(field(vector, "mode").as_str().unwrap());
            let expected = expected_result(field(vector, "expected"));
            let actual = round_div(num, den, mode);
            if actual != expected {
                fail(vector, "round_div", &expected, &actual);
            }
        }
    }

    #[test]
    fn conformance_mul_div() {
        let doc = parse_vectors();
        for vector in doc.get("vectors").and_then(Json::as_arr).unwrap() {
            if field(vector, "op").as_str() != Some("mul_div") {
                continue;
            }
            let a = int_field(vector, "a");
            let b = int_field(vector, "b");
            let den = int_field(vector, "den");
            let mode = rounding_mode(field(vector, "mode").as_str().unwrap());
            let expected = expected_result(field(vector, "expected"));
            let actual = mul_div(a, b, den, mode);
            if actual != expected {
                fail(vector, "mul_div", &expected, &actual);
            }
        }
    }

    #[test]
    fn conformance_bounded_add() {
        let doc = parse_vectors();
        for vector in doc.get("vectors").and_then(Json::as_arr).unwrap() {
            if field(vector, "op").as_str() != Some("bounded_add") {
                continue;
            }
            let a = int_field(vector, "a");
            let b = int_field(vector, "b");
            let max = int_field(vector, "max");
            let expected = expected_result(field(vector, "expected"));
            let actual = bounded_add(a, b, max);
            if actual != expected {
                fail(vector, "bounded_add", &expected, &actual);
            }
        }
    }

    #[test]
    fn conformance_bounded_sub() {
        let doc = parse_vectors();
        for vector in doc.get("vectors").and_then(Json::as_arr).unwrap() {
            if field(vector, "op").as_str() != Some("bounded_sub") {
                continue;
            }
            let a = int_field(vector, "a");
            let b = int_field(vector, "b");
            let expected = expected_result(field(vector, "expected"));
            let actual = bounded_sub(a, b);
            if actual != expected {
                fail(vector, "bounded_sub", &expected, &actual);
            }
        }
    }

    #[test]
    fn conformance_split_pro_rata() {
        let doc = parse_vectors();
        for vector in doc.get("vectors").and_then(Json::as_arr).unwrap() {
            if field(vector, "op").as_str() != Some("split_pro_rata") {
                continue;
            }
            let env = Env::default();
            let total = int_field(vector, "total");
            let weights = int_array_field(vector, "weights");
            let expected = expected_result(field(vector, "expected"));
            let weight_vec = Vec::from_slice(&env, &weights);
            let actual = split_pro_rata(&env, total, &weight_vec);
            if actual != expected {
                fail(vector, "split_pro_rata", &expected, &actual);
            }
        }
    }

    /// Asset-precision vectors pin the generated policy constants: each entry
    /// names an asset, its decimals, and its minimum unit, and must match the
    /// values emitted into [`policy`] by `scripts/gen-money.ts`.
    #[test]
    fn conformance_asset_precision() {
        let doc = parse_vectors();
        for vector in doc.get("vectors").and_then(Json::as_arr).unwrap() {
            if field(vector, "op").as_str() != Some("asset_precision") {
                continue;
            }
            let asset = field(vector, "asset").as_str().unwrap();
            let decimals = int_field(vector, "decimals");
            let min_unit = int_field(vector, "min_unit");
            let expected = expected_result(field(vector, "expected"));

            let actual = policy::asset_precision(asset);
            if actual != expected {
                fail(vector, "asset_precision", &expected, &actual);
            }
            if let Ok(scale) = actual {
                assert_eq!(
                    scale,
                    min_unit,
                    "[{}] vector `{}`: min_unit disagrees with policy for `{}`",
                    PACKAGE,
                    vector_id(vector),
                    asset
                );
                assert_eq!(
                    decimals,
                    policy::decimals_for(asset).unwrap_or(decimals),
                    "[{}] vector `{}`: decimals disagree with policy for `{}`",
                    PACKAGE,
                    vector_id(vector),
                    asset
                );
            }
        }
    }

    /// The stroop scale is the anchor for every conversion; guard it here so a
    /// regeneration that silently changes it fails loudly.
    #[test]
    fn conformance_stroop_scale() {
        assert_eq!(
            STROOP_SCALE,
            policy::STROOP_SCALE,
            "[{}] STROOP_SCALE re-export drifted from policy",
            PACKAGE
        );
        assert_eq!(
            STROOP_SCALE, 10_000_000,
            "[{}] STROOP_SCALE must be 10^7",
            PACKAGE
        );
    }
}
