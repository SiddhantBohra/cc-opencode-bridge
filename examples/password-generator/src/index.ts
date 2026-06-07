#!/usr/bin/env node

import { randomInt } from "node:crypto";
import { Command } from "commander";

export const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DIGITS = "0123456789";
export const SYMBOLS = "!@#$%^&*()_+-=[]{}|;:,.<>?~";

export function generatePassword(length: number, pool: string): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(pool[randomInt(pool.length)]);
  }
  return chars.join("");
}

export function generatePasswords(count: number, length: number, pool: string): string[] {
  return Array.from({ length: count }, () => generatePassword(length, pool));
}

export function buildPool(includeDigits: boolean, includeSymbols: boolean): string {
  let pool = LOWERCASE + UPPERCASE;
  if (includeDigits) pool += DIGITS;
  if (includeSymbols) pool += SYMBOLS;
  return pool;
}

function main() {
  const program = new Command();

  program
    .name("password-gen")
    .description("Generate cryptographically secure passwords")
    .option("-l, --length <number>", "Password length", "16")
    .option("-c, --count <number>", "Number of passwords to generate", "1")
    .option("--no-digits", "Exclude digits")
    .option("--no-symbols", "Exclude symbols")
    .parse(process.argv);

  const opts = program.opts();
  const length = parseInt(opts.length, 10);
  const count = parseInt(opts.count, 10);

  if (isNaN(length) || length < 1) {
    console.error("Error: length must be a positive integer");
    process.exit(1);
  }

  if (isNaN(count) || count < 1) {
    console.error("Error: count must be a positive integer");
    process.exit(1);
  }

  const pool = buildPool(opts.digits !== false, opts.symbols !== false);

  if (pool.length === 0) {
    console.error("Error: character pool is empty. Cannot exclude both digits and symbols.");
    process.exit(1);
  }

  const passwords = generatePasswords(count, length, pool);
  for (const pwd of passwords) {
    console.log(pwd);
  }
}

import { fileURLToPath } from "node:url";

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
