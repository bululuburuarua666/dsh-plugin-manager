// Minimal, dependency-free ZIP support for the release pipeline.
// Writer: STORE-method entries (the payload is a ~300KB tarball; compression
// saves nothing meaningful and STORE keeps the format trivially correct).
// Reader: independent central-directory parser — the verifier must not
// "self-certify" an archive with the same tool that wrote it, and must
// reject anything without the real ZIP magic (a tar named .zip fails here).
// Both halves run on every platform Node runs on; no bsdtar assumptions.

import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3), table-driven.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ---------------------------------------------------------------------------
// Writer (STORE, with optional deflate for entries > 64 KiB).
// ---------------------------------------------------------------------------

/** One entry to pack. */
export function zipStore(entries) {
  /** [name, Uint8Array] pairs in order. */
  const files = entries.map(({ name, data }) => ({ name, data: Buffer.from(data) }))
  const chunks = []
  const central = []
  let offset = 0
  const put = (buffer) => { chunks.push(buffer); offset += buffer.length }

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    let method = 0
    let payload = file.data
    if (file.data.length > 65_536) {
      const deflated = deflateRawSync(file.data, { level: 6 })
      if (deflated.length < file.data.length) { method = 8; payload = deflated }
    }
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)          // local magic
    localHeader.writeUInt16LE(20, 4)                   // version needed
    localHeader.writeUInt16LE(0, 6)                    // flags
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10)                   // time
    localHeader.writeUInt16LE(0x21, 12)                // date (1996-01-01, deterministic)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(file.data.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28)                   // extra length
    put(localHeader); put(nameBytes); put(payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)                 // version made by
    centralHeader.writeUInt16LE(20, 6)                 // version needed
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0x21, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(file.data.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30)                 // extra
    centralHeader.writeUInt16LE(0, 32)                 // comment
    centralHeader.writeUInt16LE(0, 34)                 // disk
    centralHeader.writeUInt16LE(0, 36)                 // internal attrs
    centralHeader.writeUInt32LE(0, 38)                 // external attrs
    centralHeader.writeUInt32LE(offset - payload.length - nameBytes.length - 30, 42)
    central.push(centralHeader)
    central.push(nameBytes)
  }

  const centralStart = offset
  for (const piece of central) put(piece)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  put(end)
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// Reader: independent central-directory walk with magic + CRC verification.
// ---------------------------------------------------------------------------

/** Parse a real ZIP; throws on wrong magic, truncation, or CRC mismatch. */
export function zipLoad(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(buffer.length - 22) !== 0x06054b50) {
    throw new Error('zip: not a ZIP archive (missing end-of-central-directory record)')
  }
  const end = buffer.length - 22
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const files = []
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`zip: central directory entry ${i} corrupt`)
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: local header for ${name} corrupt`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`zip: entry ${name} uses unsupported method ${method}`)
    if (data.length !== size) throw new Error(`zip: entry ${name} size mismatch`)
    if (crc32(data) !== crc) throw new Error(`zip: entry ${name} CRC mismatch`)
    files.push({ name, data })
  }
  return files
}

/** Convenience: SHA-256 of one member. */
export function zipMemberDigest(files, name) {
  const entry = files.find(file => file.name === name)
  if (entry === undefined) throw new Error(`zip: no member ${name}`)
  return createHash('sha256').update(entry.data).digest('hex')
}
