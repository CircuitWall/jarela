// Built-in validators referenced by name from redaction-patterns.json.
// Keeping them as named functions (not arbitrary code from the JSON file)
// is part of the trust model — the pattern file stays declarative.

export type Validator = (value: string) => boolean;

// Standard Luhn checksum on the digits of `value` (non-digit chars are
// stripped first). Used by Swedish personnummer (10-digit form),
// bankgiro, and plusgiro.
export function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 2) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Swedish personnummer check. Accepts 10 or 12 digit forms (with - or +
// separator); both validate against Luhn over the 10-digit form.
// Date sanity is enforced — rules out matches on unrelated date strings.
export function personnummer_check(value: string): boolean {
  const cleaned = value.replace(/\D/g, "");
  let ten: string;
  if (cleaned.length === 10) {
    ten = cleaned;
  } else if (cleaned.length === 12) {
    ten = cleaned.slice(2);
  } else {
    return false;
  }
  const month = Number.parseInt(ten.slice(2, 4), 10);
  const day = Number.parseInt(ten.slice(4, 6), 10);
  // Coordination numbers ("samordningsnummer") add 60 to the day field —
  // keep them in range too.
  if (month < 1 || month > 12) return false;
  if (day < 1 || (day > 31 && day < 61) || day > 91) return false;
  return luhn(ten);
}

// IBAN mod-97 check. Strips spaces, moves the first 4 chars to the end,
// converts letters to digits (A=10..Z=35), and asserts the resulting
// integer mod 97 equals 1.
export function mod97(value: string): boolean {
  const cleaned = value.replace(/\s+/g, "").toUpperCase();
  if (cleaned.length < 5) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged.charCodeAt(i);
    let digit: number;
    if (ch >= 48 && ch <= 57) {
      digit = ch - 48;
    } else if (ch >= 65 && ch <= 90) {
      digit = ch - 55; // 'A' (65) -> 10, ..., 'Z' (90) -> 35
    } else {
      return false;
    }
    // Process two-digit numbers for letters, one-digit for digits — the
    // standard incremental mod-97 algorithm.
    if (digit >= 10) {
      remainder = (remainder * 100 + digit) % 97;
    } else {
      remainder = (remainder * 10 + digit) % 97;
    }
  }
  return remainder === 1;
}

export const VALIDATORS: Record<string, Validator> = {
  luhn,
  mod97,
  personnummer_check,
};
