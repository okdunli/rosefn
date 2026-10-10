import fs from "node:fs";

export interface ImageDims {
  width: number;
  height: number;
}

/** Parse dimensions from the leading bytes of an image file. */
export function readImageSize(filePath: string): ImageDims | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(64);
    const read = fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    if (read < 24) return null;

    if (
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    ) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    if (buf.slice(0, 3).toString("latin1") === "GIF") {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    if (
      buf.slice(0, 4).toString("latin1") === "RIFF" &&
      buf.slice(8, 12).toString("latin1") === "WEBP"
    ) {
      return parseWebP(buf);
    }

    if (buf[0] === 0xff && buf[1] === 0xd8) {
      return parseJpeg(filePath);
    }

    return null;
  } catch {
    return null;
  }
}

function parseWebP(buf: Buffer): ImageDims | null {
  const format = buf.slice(12, 16).toString("latin1");
  if (format === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    const w = buf.readUIntLE(24, 3) + 1;
    const h = buf.readUIntLE(27, 3) + 1;
    return { width: w, height: h };
  }
  return null;
}

function parseJpeg(filePath: string): ImageDims | null {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(4);
    let pos = 2;
    for (let guard = 0; guard < 64; guard++) {
      if (fs.readSync(fd, buf, 0, 4, pos) < 4) return null;
      if (buf[0] !== 0xff) { pos += 1; continue; }
      const marker = buf[1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
      const len = fs.readSync(fd, buf, 0, 2, pos + 2) < 2 ? 0 : buf.readUInt16BE(2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const seg = Buffer.alloc(8);
        fs.readSync(fd, seg, 0, 8, pos + 4);
        return { width: seg.readUInt16BE(3), height: seg.readUInt16BE(1) };
      }
      pos += 2 + len;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
