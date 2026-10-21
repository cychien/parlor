// Binary property lists (bplist00), the framing of the WebKit remote inspector protocol.
// Encodes null, booleans, integers, reals, strings, Buffers (data), arrays and plain objects.

function intBytes(value) {
  return value < 0x100 ? 1 : value < 0x10000 ? 2 : value < 0x100000000 ? 4 : 8;
}

function writeUInt(buffer, offset, size, value) {
  if (size === 8) buffer.writeBigUInt64BE(BigInt(value), offset);
  else buffer.writeUIntBE(value, offset, size);
}

function readUInt(buffer, offset, size) {
  if (size === 8) return Number(buffer.readBigUInt64BE(offset));
  return buffer.readUIntBE(offset, size);
}

export function encodeBplist(root) {
  const objects = [];
  const flatten = (value) => {
    const index = objects.length;
    const entry = { value, refs: undefined };
    objects.push(entry);
    if (Array.isArray(value)) entry.refs = value.map(flatten);
    else if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined);
      entry.refs = [...keys.map(flatten), ...keys.map((key) => flatten(value[key]))];
      entry.keys = keys.length;
    }
    return index;
  };
  flatten(root);
  const refSize = intBytes(objects.length);
  const marker = (type, count) => {
    if (count < 15) return Buffer.from([type | count]);
    const size = intBytes(count);
    const sizeCode = { 1: 0, 2: 1, 4: 2, 8: 3 }[size];
    const out = Buffer.alloc(2 + size);
    out[0] = type | 0x0f;
    out[1] = 0x10 | sizeCode;
    writeUInt(out, 2, size, count);
    return out;
  };
  const refs = (list) => {
    const out = Buffer.alloc(list.length * refSize);
    list.forEach((ref, i) => writeUInt(out, i * refSize, refSize, ref));
    return out;
  };
  const chunks = [Buffer.from("bplist00", "ascii")];
  const offsets = [];
  let position = 8;
  for (const entry of objects) {
    const { value } = entry;
    let bytes;
    if (value === null) bytes = Buffer.from([0x00]);
    else if (value === false) bytes = Buffer.from([0x08]);
    else if (value === true) bytes = Buffer.from([0x09]);
    else if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      const size = value < 0x100 ? 1 : value < 0x10000 ? 2 : value < 0x100000000 ? 4 : 8;
      bytes = Buffer.alloc(1 + size);
      bytes[0] = 0x10 | { 1: 0, 2: 1, 4: 2, 8: 3 }[size];
      writeUInt(bytes, 1, size, value);
    } else if (typeof value === "number") {
      bytes = Buffer.alloc(9);
      bytes[0] = 0x23;
      bytes.writeDoubleBE(value, 1);
    } else if (typeof value === "string") {
      if ([...value].every((c) => c.charCodeAt(0) < 0x80)) {
        bytes = Buffer.concat([marker(0x50, value.length), Buffer.from(value, "ascii")]);
      } else {
        const utf16 = Buffer.from(value, "utf16le").swap16();
        bytes = Buffer.concat([marker(0x60, utf16.length / 2), utf16]);
      }
    } else if (Buffer.isBuffer(value)) {
      bytes = Buffer.concat([marker(0x40, value.length), value]);
    } else if (Array.isArray(value)) {
      bytes = Buffer.concat([marker(0xa0, entry.refs.length), refs(entry.refs)]);
    } else {
      bytes = Buffer.concat([marker(0xd0, entry.keys), refs(entry.refs)]);
    }
    offsets.push(position);
    chunks.push(bytes);
    position += bytes.length;
  }
  const offsetSize = intBytes(position);
  const table = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((offset, i) => writeUInt(table, i * offsetSize, offsetSize, offset));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(position), 24);
  return Buffer.concat([...chunks, table, trailer]);
}

export function decodeBplist(buffer) {
  if (buffer.subarray(0, 8).toString("ascii") !== "bplist00")
    throw new Error("not a binary plist");
  const trailer = buffer.subarray(buffer.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const count = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const tableAt = Number(trailer.readBigUInt64BE(24));
  const offsets = Array.from({ length: count }, (_, i) =>
    readUInt(buffer, tableAt + i * offsetSize, offsetSize),
  );
  const length = (at, low) => {
    if (low !== 0x0f) return { count: low, start: at + 1 };
    const size = 1 << (buffer[at + 1] & 0x0f);
    return { count: readUInt(buffer, at + 2, size), start: at + 2 + size };
  };
  const parse = (index) => {
    const at = offsets[index];
    const head = buffer[at];
    const type = head & 0xf0;
    const low = head & 0x0f;
    switch (type) {
      case 0x00:
        return low === 0x08 ? false : low === 0x09 ? true : null;
      case 0x10: {
        const size = 1 << low;
        return size === 8
          ? Number(buffer.readBigInt64BE(at + 1))
          : readUInt(buffer, at + 1, size);
      }
      case 0x20:
        return low === 2 ? buffer.readFloatBE(at + 1) : buffer.readDoubleBE(at + 1);
      case 0x30:
        return new Date((978307200 + buffer.readDoubleBE(at + 1)) * 1000);
      case 0x40: {
        const { count: n, start } = length(at, low);
        return Buffer.from(buffer.subarray(start, start + n));
      }
      case 0x50: {
        const { count: n, start } = length(at, low);
        return buffer.subarray(start, start + n).toString("ascii");
      }
      case 0x60: {
        const { count: n, start } = length(at, low);
        return Buffer.from(buffer.subarray(start, start + n * 2))
          .swap16()
          .toString("utf16le");
      }
      case 0x80:
        return { uid: readUInt(buffer, at + 1, low + 1) };
      case 0xa0: {
        const { count: n, start } = length(at, low);
        return Array.from({ length: n }, (_, i) =>
          parse(readUInt(buffer, start + i * refSize, refSize)),
        );
      }
      case 0xd0: {
        const { count: n, start } = length(at, low);
        const out = {};
        for (let i = 0; i < n; i++) {
          const key = parse(readUInt(buffer, start + i * refSize, refSize));
          out[key] = parse(readUInt(buffer, start + (n + i) * refSize, refSize));
        }
        return out;
      }
      default:
        throw new Error(`unsupported bplist object 0x${head.toString(16)}`);
    }
  };
  return parse(top);
}
