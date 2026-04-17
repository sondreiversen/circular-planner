/**
 * Minimal NTLMv2 handshake using Node's built-in crypto module.
 *
 * Implements just enough of the NTLM protocol to authenticate a single
 * request against an on-premises Exchange server. No external dependencies.
 *
 * References:
 *   - MS-NLMP: https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-nlmp
 *   - NTLM type messages: https://davenport.sourceforge.net/ntlm.html
 */
import crypto from 'crypto';

export interface NtlmCredentials {
  username: string;
  password: string;
  domain: string;
}

/** Parse "DOMAIN\\user" into { domain, username }. Plain "user" gets empty domain. */
export function parseCredentials(usernameField: string, password: string): NtlmCredentials {
  const parts = usernameField.split('\\');
  if (parts.length === 2) {
    return { domain: parts[0], username: parts[1], password };
  }
  return { domain: '', username: usernameField, password };
}

// ── Type 1 (Negotiate) ──────────────────────────────────────────────────────

const NTLM_SIGNATURE = Buffer.from('NTLMSSP\0', 'ascii');

export function createType1Message(domain: string): string {
  const domainBytes = Buffer.from(domain.toUpperCase(), 'ascii');
  const workstation = Buffer.from('WORKSTATION', 'ascii');

  // Flags: Negotiate Unicode, Negotiate NTLM, Request Target, Negotiate NTLM2Key
  const flags = 0x00000001 | 0x00000200 | 0x00000004 | 0x00080000 | 0x00008000;

  const buf = Buffer.alloc(32 + domainBytes.length + workstation.length);
  NTLM_SIGNATURE.copy(buf, 0);
  buf.writeUInt32LE(1, 8);          // Type 1
  buf.writeUInt32LE(flags, 12);
  // Domain security buffer
  buf.writeUInt16LE(domainBytes.length, 16);
  buf.writeUInt16LE(domainBytes.length, 18);
  buf.writeUInt32LE(32, 20);
  // Workstation security buffer
  buf.writeUInt16LE(workstation.length, 24);
  buf.writeUInt16LE(workstation.length, 26);
  buf.writeUInt32LE(32 + domainBytes.length, 28);

  domainBytes.copy(buf, 32);
  workstation.copy(buf, 32 + domainBytes.length);

  return buf.toString('base64');
}

// ── Type 2 (Challenge) parsing ───────────────────────────────────────────────

export interface Type2Data {
  challenge: Buffer;
  targetInfo: Buffer;
}

export function parseType2Message(base64: string): Type2Data {
  const buf = Buffer.from(base64, 'base64');

  if (buf.toString('ascii', 0, 7) !== 'NTLMSSP') {
    throw new Error('Invalid NTLM Type 2 message');
  }
  if (buf.readUInt32LE(8) !== 2) {
    throw new Error('Not an NTLM Type 2 message');
  }

  const challenge = buf.subarray(24, 32);

  // Target info security buffer
  let targetInfo = Buffer.alloc(0);
  if (buf.length >= 48) {
    const tiLen = buf.readUInt16LE(40);
    const tiOff = buf.readUInt32LE(44);
    if (tiOff + tiLen <= buf.length) {
      targetInfo = buf.subarray(tiOff, tiOff + tiLen);
    }
  }

  return { challenge, targetInfo };
}

// ── Type 3 (Authenticate) ───────────────────────────────────────────────────

function md4(data: Buffer): Buffer {
  return crypto.createHash('md4').update(data).digest();
}

function hmacMd5(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('md5', key).update(data).digest();
}

function ntv2Hash(creds: NtlmCredentials): Buffer {
  const passUnicode = Buffer.from(creds.password, 'utf16le');
  const ntHash = md4(passUnicode);
  const identity = (creds.username.toUpperCase() + creds.domain.toUpperCase());
  const identityUnicode = Buffer.from(identity, 'utf16le');
  return hmacMd5(ntHash, identityUnicode);
}

export function createType3Message(creds: NtlmCredentials, type2: Type2Data): string {
  const ntv2 = ntv2Hash(creds);

  // Build NTLMv2 client challenge (blob)
  const clientNonce = crypto.randomBytes(8);
  const timestamp = ntTimestamp();

  // NTLMv2 blob: 0x01010000 + reserved(4) + timestamp(8) + clientNonce(8) + reserved(4) + targetInfo + reserved(4)
  const blob = Buffer.alloc(28 + type2.targetInfo.length + 4);
  blob.writeUInt32LE(0x00000101, 0);  // blob signature + reserved
  blob.writeUInt32LE(0, 4);           // reserved
  timestamp.copy(blob, 8);
  clientNonce.copy(blob, 16);
  blob.writeUInt32LE(0, 24);          // reserved
  type2.targetInfo.copy(blob, 28);
  blob.writeUInt32LE(0, 28 + type2.targetInfo.length); // trailing reserved

  // NTProofStr = HMAC_MD5(ntv2Hash, serverChallenge + blob)
  const ntProofStr = hmacMd5(ntv2, Buffer.concat([type2.challenge, blob]));
  const ntResponse = Buffer.concat([ntProofStr, blob]);

  // LMv2 response = HMAC_MD5(ntv2Hash, serverChallenge + clientNonce) + clientNonce
  const lmResponse = Buffer.concat([
    hmacMd5(ntv2, Buffer.concat([type2.challenge, clientNonce])),
    clientNonce,
  ]);

  // Session key
  const sessionKey = hmacMd5(ntv2, ntProofStr);

  // Build Type 3 message
  const domainUnicode = Buffer.from(creds.domain.toUpperCase(), 'utf16le');
  const userUnicode = Buffer.from(creds.username, 'utf16le');
  const workstationUnicode = Buffer.from('WORKSTATION', 'utf16le');

  const flags = 0x00000001 | 0x00000200 | 0x00000004 | 0x00080000 | 0x00008000 | 0x00000010;

  // Calculate offsets (fixed header = 72 bytes)
  const headerLen = 72;
  let offset = headerLen;

  const lmOff = offset; offset += lmResponse.length;
  const ntOff = offset; offset += ntResponse.length;
  const domOff = offset; offset += domainUnicode.length;
  const userOff = offset; offset += userUnicode.length;
  const wsOff = offset; offset += workstationUnicode.length;
  const skOff = offset; offset += sessionKey.length;

  const buf = Buffer.alloc(offset);
  NTLM_SIGNATURE.copy(buf, 0);
  buf.writeUInt32LE(3, 8);           // Type 3

  // LM response security buffer
  buf.writeUInt16LE(lmResponse.length, 12);
  buf.writeUInt16LE(lmResponse.length, 14);
  buf.writeUInt32LE(lmOff, 16);

  // NT response security buffer
  buf.writeUInt16LE(ntResponse.length, 20);
  buf.writeUInt16LE(ntResponse.length, 22);
  buf.writeUInt32LE(ntOff, 24);

  // Domain security buffer
  buf.writeUInt16LE(domainUnicode.length, 28);
  buf.writeUInt16LE(domainUnicode.length, 30);
  buf.writeUInt32LE(domOff, 32);

  // User security buffer
  buf.writeUInt16LE(userUnicode.length, 36);
  buf.writeUInt16LE(userUnicode.length, 38);
  buf.writeUInt32LE(userOff, 40);

  // Workstation security buffer
  buf.writeUInt16LE(workstationUnicode.length, 44);
  buf.writeUInt16LE(workstationUnicode.length, 46);
  buf.writeUInt32LE(wsOff, 48);

  // Session key security buffer
  buf.writeUInt16LE(sessionKey.length, 52);
  buf.writeUInt16LE(sessionKey.length, 54);
  buf.writeUInt32LE(skOff, 56);

  // Flags
  buf.writeUInt32LE(flags, 60);

  // Copy payloads
  lmResponse.copy(buf, lmOff);
  ntResponse.copy(buf, ntOff);
  domainUnicode.copy(buf, domOff);
  userUnicode.copy(buf, userOff);
  workstationUnicode.copy(buf, wsOff);
  sessionKey.copy(buf, skOff);

  return buf.toString('base64');
}

/** NTLM timestamp: 100-nanosecond intervals since 1601-01-01. */
function ntTimestamp(): Buffer {
  const epoch = BigInt(Date.now()) * 10000n + 116444736000000000n;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(epoch);
  return buf;
}
