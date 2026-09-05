import fs from "node:fs";

export interface CappedCommandOutput {
  text: string;
  sourceTruncated: boolean;
  encoding: "utf8" | "gb18030";
}

function decodeCommandBytes(bytes: Buffer): Pick<CappedCommandOutput, "text" | "encoding"> {
  const maxBoundaryTrim = Math.min(4, bytes.length);
  for (let cut = bytes.length; cut >= bytes.length - maxBoundaryTrim; cut -= 1) {
    const candidate = bytes.subarray(0, cut);
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(candidate), encoding: "utf8" };
    } catch {
      // A capped read may end in the middle of a UTF-8 code point.
    }
  }
  for (let cut = bytes.length; cut >= bytes.length - maxBoundaryTrim; cut -= 1) {
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
    // Read look-ahead bytes so a capped UTF-8/GB18030 character can be
    // removed at the boundary without emitting replacement characters.
    const buf = Buffer.alloc(Math.min(size, maxBytes + 4));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const bounded = buf.subarray(0, Math.min(n, maxBytes));
    return { ...decodeCommandBytes(bounded), sourceTruncated };
  } finally {
    fs.closeSync(fd);
  }
}
