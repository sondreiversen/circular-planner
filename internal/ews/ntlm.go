// NTLMv2 handshake (Type 1 / Type 2 / Type 3) implemented on top of Go's
// standard library. Used by the EWS client to authenticate against an
// on-premises Exchange server that has NTLM enabled.
//
// References:
//   - MS-NLMP: https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-nlmp
//   - NTLM type messages: https://davenport.sourceforge.net/ntlm.html
package ews

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/crypto/md4"
)

// Credentials carries the parsed username/domain/password for an NTLM handshake.
type Credentials struct {
	Username string
	Password string
	Domain   string
}

// Type2Data is the subset of a parsed Type 2 challenge that the client needs
// to build a Type 3 response.
type Type2Data struct {
	Challenge  []byte // 8 bytes
	TargetInfo []byte
}

// ntlmSignature is the fixed 8-byte signature at the start of every NTLM message.
var ntlmSignature = []byte("NTLMSSP\x00")

// ParseCredentials splits "DOMAIN\user" into (domain, username). Plain "user"
// yields an empty domain.
func ParseCredentials(userField, password string) Credentials {
	if i := strings.Index(userField, `\`); i >= 0 {
		return Credentials{
			Domain:   userField[:i],
			Username: userField[i+1:],
			Password: password,
		}
	}
	return Credentials{Username: userField, Password: password}
}

// CreateType1Message builds the negotiate message. The domain is uppercased
// ASCII. Returns the raw (pre-base64) bytes.
func CreateType1Message(domain string) []byte {
	domainBytes := []byte(strings.ToUpper(domain))
	workstation := []byte("WORKSTATION")

	// Flags: Negotiate Unicode | NTLM | RequestTarget | NTLM2Key | AlwaysSign
	var flags uint32 = 0x00000001 | 0x00000200 | 0x00000004 | 0x00080000 | 0x00008000

	buf := make([]byte, 32+len(domainBytes)+len(workstation))
	copy(buf, ntlmSignature)
	binary.LittleEndian.PutUint32(buf[8:], 1) // type 1
	binary.LittleEndian.PutUint32(buf[12:], flags)

	// Domain security buffer
	binary.LittleEndian.PutUint16(buf[16:], uint16(len(domainBytes)))
	binary.LittleEndian.PutUint16(buf[18:], uint16(len(domainBytes)))
	binary.LittleEndian.PutUint32(buf[20:], 32)

	// Workstation security buffer
	binary.LittleEndian.PutUint16(buf[24:], uint16(len(workstation)))
	binary.LittleEndian.PutUint16(buf[26:], uint16(len(workstation)))
	binary.LittleEndian.PutUint32(buf[28:], 32+uint32(len(domainBytes)))

	copy(buf[32:], domainBytes)
	copy(buf[32+len(domainBytes):], workstation)
	return buf
}

// ParseType2Message decodes a base64-encoded challenge from WWW-Authenticate.
func ParseType2Message(b64 string) (Type2Data, error) {
	buf, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return Type2Data{}, err
	}
	if len(buf) < 32 {
		return Type2Data{}, errors.New("NTLM Type 2: message too short")
	}
	if string(buf[:7]) != "NTLMSSP" {
		return Type2Data{}, errors.New("NTLM Type 2: bad signature")
	}
	if binary.LittleEndian.Uint32(buf[8:]) != 2 {
		return Type2Data{}, errors.New("NTLM Type 2: not a Type 2 message")
	}

	challenge := append([]byte(nil), buf[24:32]...)

	var targetInfo []byte
	if len(buf) >= 48 {
		tiLen := int(binary.LittleEndian.Uint16(buf[40:]))
		tiOff := int(binary.LittleEndian.Uint32(buf[44:]))
		if tiOff >= 0 && tiOff+tiLen <= len(buf) {
			targetInfo = append([]byte(nil), buf[tiOff:tiOff+tiLen]...)
		}
	}
	return Type2Data{Challenge: challenge, TargetInfo: targetInfo}, nil
}

// CreateType3Message produces the authenticate message.
func CreateType3Message(creds Credentials, t2 Type2Data) []byte {
	ntv2 := ntv2Hash(creds)

	clientNonce := make([]byte, 8)
	_, _ = rand.Read(clientNonce)
	ts := ntTimestamp()

	// NTLMv2 blob
	blob := make([]byte, 28+len(t2.TargetInfo)+4)
	binary.LittleEndian.PutUint32(blob[0:], 0x00000101) // blob signature + reserved
	binary.LittleEndian.PutUint32(blob[4:], 0)          // reserved
	copy(blob[8:], ts)
	copy(blob[16:], clientNonce)
	binary.LittleEndian.PutUint32(blob[24:], 0) // reserved
	copy(blob[28:], t2.TargetInfo)
	// trailing reserved (last 4 bytes already zero)

	// NTProofStr = HMAC_MD5(ntv2, challenge || blob)
	ntProof := hmacMD5(ntv2, concat(t2.Challenge, blob))
	ntResponse := concat(ntProof, blob)

	// LMv2 response = HMAC_MD5(ntv2, challenge || clientNonce) || clientNonce
	lmResponse := concat(hmacMD5(ntv2, concat(t2.Challenge, clientNonce)), clientNonce)

	sessionKey := hmacMD5(ntv2, ntProof)

	domainUnicode := utf16LE(strings.ToUpper(creds.Domain))
	userUnicode := utf16LE(creds.Username)
	workstationUnicode := utf16LE("WORKSTATION")

	var flags uint32 = 0x00000001 | 0x00000200 | 0x00000004 | 0x00080000 | 0x00008000 | 0x00000010

	headerLen := 72
	offset := headerLen

	lmOff := offset
	offset += len(lmResponse)
	ntOff := offset
	offset += len(ntResponse)
	domOff := offset
	offset += len(domainUnicode)
	userOff := offset
	offset += len(userUnicode)
	wsOff := offset
	offset += len(workstationUnicode)
	skOff := offset
	offset += len(sessionKey)

	buf := make([]byte, offset)
	copy(buf, ntlmSignature)
	binary.LittleEndian.PutUint32(buf[8:], 3) // type 3

	writeSecBuf(buf[12:], len(lmResponse), lmOff)
	writeSecBuf(buf[20:], len(ntResponse), ntOff)
	writeSecBuf(buf[28:], len(domainUnicode), domOff)
	writeSecBuf(buf[36:], len(userUnicode), userOff)
	writeSecBuf(buf[44:], len(workstationUnicode), wsOff)
	writeSecBuf(buf[52:], len(sessionKey), skOff)

	binary.LittleEndian.PutUint32(buf[60:], flags)

	copy(buf[lmOff:], lmResponse)
	copy(buf[ntOff:], ntResponse)
	copy(buf[domOff:], domainUnicode)
	copy(buf[userOff:], userUnicode)
	copy(buf[wsOff:], workstationUnicode)
	copy(buf[skOff:], sessionKey)

	return buf
}

// --- helpers ---

func ntv2Hash(c Credentials) []byte {
	pwd := utf16LE(c.Password)
	h := md4.New()
	h.Write(pwd)
	ntHash := h.Sum(nil)

	identity := utf16LE(strings.ToUpper(c.Username) + strings.ToUpper(c.Domain))
	return hmacMD5(ntHash, identity)
}

func hmacMD5(key, data []byte) []byte {
	m := hmac.New(md5.New, key)
	m.Write(data)
	return m.Sum(nil)
}

// utf16LE encodes a Go string as UTF-16 little-endian bytes (no BOM).
func utf16LE(s string) []byte {
	runes := utf16.Encode([]rune(s))
	out := make([]byte, len(runes)*2)
	for i, r := range runes {
		binary.LittleEndian.PutUint16(out[i*2:], r)
	}
	return out
}

// ntTimestamp returns a little-endian 8-byte count of 100-nanosecond intervals
// since 1601-01-01 (the Windows epoch).
func ntTimestamp() []byte {
	// Unix epoch → Windows epoch offset = 11644473600 seconds.
	ns100 := uint64(time.Now().UnixNano()/100) + 116444736000000000
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, ns100)
	return buf
}

func writeSecBuf(dst []byte, length, offset int) {
	binary.LittleEndian.PutUint16(dst[0:], uint16(length))
	binary.LittleEndian.PutUint16(dst[2:], uint16(length))
	binary.LittleEndian.PutUint32(dst[4:], uint32(offset))
}

func concat(parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
