import fs from "node:fs";

export interface CappedCommandOutput {
  text: string;
  sourceTruncated: boolean;
  encoding: "utf8" | "gb18030";
}

function decodeCommandBytes(bytes: Buffer, sourceTruncated: boolean): Pick<CappedCommandOutput, "text" | "encoding"> {
  // A complete file must be decoded as a complete file. Trimming a short
  // CP936 stream while probing encodings can turn it into an empty UTF-8
  // result and can hide an invalid final byte. Only a bounded prefix may trim
  // an incomplete code point at its cap boundary.
  if (!sourceTruncated) {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" };
    } catch {
      try {
        return { text: new TextDecoder("gb18030", { fatal: true }).decode(bytes), encoding: "gb18030" };
      } catch {
        return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf8" };
      }
    }
  }

  const maxBoundaryTrim = Math.min(4, bytes.length);
  for (let cut = bytes.length; cut >= bytes.length - maxBoundaryTrim; cut -= 1) {
    if (bytes.length > 0 && cut === 0) continue;
    const candidate = bytes.subarray(0, cut);
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(candidate), encoding: "utf8" };
    } catch {
      // A capped read may end in the middle of a UTF-8 code point.
    }
  }
  for (let cut = bytes.length; cut >= bytes.length - maxBoundaryTrim; cut -= 1) {
    if (bytes.length > 0 && cut === 0) continue;
    const candidate = bytes.subarray(0, cut);
    try {
      return { text: new TextDecoder("gb18030", { fatal: true }).decode(candidate), encoding: "gb18030" };
    } catch {
      // A capped read may end in the middle of a GB18030/CP936 character.
    }
  }
  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf8" };
}

/** Read a local command output prefix while reporting a byte cap explicitly. */
export function readCappedUtf8(filePath: string, maxBytes: number): CappedCommandOutput {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const sourceTruncated = size > maxBytes;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const bounded = buf.subarray(0, Math.min(n, maxBytes));
    return { ...decodeCommandBytes(bounded, sourceTruncated), sourceTruncated };
  } finally {
    fs.closeSync(fd);
  }
}
