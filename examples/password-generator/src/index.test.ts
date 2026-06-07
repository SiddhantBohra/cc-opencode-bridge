import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generatePassword,
  generatePasswords,
  buildPool,
  LOWERCASE,
  UPPERCASE,
  DIGITS,
  SYMBOLS,
} from "./index.js";

const ALL_CHARS = LOWERCASE + UPPERCASE + DIGITS + SYMBOLS;
const LETTERS_ONLY = LOWERCASE + UPPERCASE;

function charsFrom(pool: string): Set<string> {
  return new Set(pool);
}

function containsAny(s: string, chars: string): boolean {
  const set = charsFrom(chars);
  for (const c of s) {
    if (set.has(c)) return true;
  }
  return false;
}

describe("buildPool", () => {
  test("includes all character types by default", () => {
    const pool = buildPool(true, true);
    assert.ok(pool.includes("a"));
    assert.ok(pool.includes("Z"));
    assert.ok(pool.includes("5"));
    assert.ok(pool.includes("$"));
    assert.equal(pool, LOWERCASE + UPPERCASE + DIGITS + SYMBOLS);
  });

  test("excludes symbols when includeSymbols is false", () => {
    const pool = buildPool(true, false);
    assert.ok(pool.includes("a"));
    assert.ok(pool.includes("Z"));
    assert.ok(pool.includes("5"));
    for (const s of SYMBOLS) {
      assert.equal(pool.includes(s), false, `symbol ${s} should be excluded`);
    }
    assert.equal(pool, LOWERCASE + UPPERCASE + DIGITS);
  });

  test("excludes digits when includeDigits is false", () => {
    const pool = buildPool(false, true);
    assert.ok(pool.includes("a"));
    assert.ok(pool.includes("Z"));
    assert.ok(pool.includes("$"));
    for (const d of DIGITS) {
      assert.equal(pool.includes(d), false, `digit ${d} should be excluded`);
    }
    assert.equal(pool, LOWERCASE + UPPERCASE + SYMBOLS);
  });

  test("excludes both digits and symbols", () => {
    const pool = buildPool(false, false);
    for (const d of DIGITS) {
      assert.equal(pool.includes(d), false);
    }
    for (const s of SYMBOLS) {
      assert.equal(pool.includes(s), false);
    }
    assert.equal(pool, LOWERCASE + UPPERCASE);
  });
});

describe("generatePassword", () => {
  test("returns the correct length", () => {
    const pool = buildPool(true, true);
    const pwd = generatePassword(16, pool);
    assert.equal(pwd.length, 16);
  });

  test("returns another password of requested length", () => {
    const pool = buildPool(true, true);
    const pwd = generatePassword(32, pool);
    assert.equal(pwd.length, 32);
  });

  test("uses only characters from the given pool", () => {
    const pool = LETTERS_ONLY;
    for (let i = 0; i < 50; i++) {
      const pwd = generatePassword(20, pool);
      for (const c of pwd) {
        assert.ok(LETTERS_ONLY.includes(c), `char '${c}' not in letter pool`);
      }
    }
  });

  test("generates different passwords on repeated calls", () => {
    const pool = buildPool(true, true);
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(generatePassword(16, pool));
    }
    assert.equal(results.size, 20);
  });

  test("--no-symbols equivalent: no symbols in output", () => {
    const pool = buildPool(true, false);
    for (let i = 0; i < 50; i++) {
      const pwd = generatePassword(20, pool);
      assert.equal(containsAny(pwd, SYMBOLS), false);
    }
  });

  test("--no-digits equivalent: no digits in output", () => {
    const pool = buildPool(false, true);
    for (let i = 0; i < 50; i++) {
      const pwd = generatePassword(20, pool);
      assert.equal(containsAny(pwd, DIGITS), false);
    }
  });
});

describe("generatePasswords", () => {
  test("returns the requested number of passwords", () => {
    const pool = buildPool(true, true);
    const passwords = generatePasswords(5, 16, pool);
    assert.equal(passwords.length, 5);
  });

  test("count=1 returns a single password", () => {
    const pool = buildPool(true, true);
    const passwords = generatePasswords(1, 16, pool);
    assert.equal(passwords.length, 1);
    assert.equal(passwords[0].length, 16);
  });

  test("count=0 returns empty array", () => {
    const pool = buildPool(true, true);
    const passwords = generatePasswords(0, 16, pool);
    assert.deepEqual(passwords, []);
  });

  test("every password has the correct length", () => {
    const pool = buildPool(true, false);
    const passwords = generatePasswords(10, 12, pool);
    for (const pwd of passwords) {
      assert.equal(pwd.length, 12);
    }
  });
});
