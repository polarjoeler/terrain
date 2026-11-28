// Positioned read of an append-only line file, for landers that keep a byte watermark.
import { openSync, readSync, closeSync } from "fs";

/** Read whole lines from [start, start+max). Returns the text and the byte offset just past the
 *  last complete line, so the next run starts exactly on a line boundary. */
export function readNewLines(path, start, size, max) {
  const fd = openSync(path, "r");
  try {
    let from = start;
    if (from > 0) {                       // an old watermark may sit mid-line: skip to the next line
      const prev = Buffer.alloc(1);
      readSync(fd, prev, 0, 1, from - 1);
      if (prev[0] !== 0x0a) {
        const probe = Buffer.alloc(Math.min(1 << 20, size - from));
        const n = readSync(fd, probe, 0, probe.length, from);
        const nl = probe.subarray(0, n).indexOf(0x0a);
        if (nl < 0) return { text: "", next: start };
        from += nl + 1;
      }
    }
    const len = Math.min(max, size - from);
    if (len <= 0) return { text: "", next: from };
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, from);
    const lastNl = buf.subarray(0, n).lastIndexOf(0x0a);
    if (lastNl < 0) return { text: "", next: from };   // no complete line yet
    return { text: buf.subarray(0, lastNl + 1).toString("utf8"), next: from + lastNl + 1 };
  } finally { closeSync(fd); }
}

