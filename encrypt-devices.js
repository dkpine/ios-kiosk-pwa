#!/usr/bin/env node
/* ============================================================
   Encrypt devices.json → devices.enc

   Uses AES-256-GCM with a static key. The encrypted file is
   safe to host publicly on GitHub Pages. The decryption key
   lives in application.js (client-side), so this is NOT
   cryptographically secure against a determined attacker who
   reads the source — it's a practical barrier against casual
   browsing of fleet data.

   Usage:
     node encrypt-devices.js

   Reads:  ./devices.json
   Writes: ./devices.enc  (binary: 12-byte IV + 16-byte tag + ciphertext)
   ============================================================ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Same key used in application.js for decryption ---
// 256-bit key as hex (32 bytes)
const KEY_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const inputPath = path.join(__dirname, 'devices.json');
const outputPath = path.join(__dirname, 'devices.enc');

const plaintext = fs.readFileSync(inputPath, 'utf8');
const key = Buffer.from(KEY_HEX, 'hex');
const iv = crypto.randomBytes(12); // 96-bit IV for GCM

const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag(); // 16 bytes

// Output format: [12-byte IV][16-byte auth tag][ciphertext]
const output = Buffer.concat([iv, tag, encrypted]);
fs.writeFileSync(outputPath, output);

console.log('Encrypted ' + plaintext.length + ' bytes → ' + output.length + ' bytes');
console.log('Written to: ' + outputPath);
console.log('IV: ' + iv.toString('hex'));
console.log('Tag: ' + tag.toString('hex'));
