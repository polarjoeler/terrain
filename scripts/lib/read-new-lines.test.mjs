// node --test scripts/lib/read-new-lines.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNewLines } from "./read-new-lines.mjs";

const file = (s) => { const p = join(mkdtempSync(join(tmpdir(), "rnl-")), "f.jsonl"); writeFileSync(p, s); return p; };

test("reads whole lines from the watermark and stops at the last newline", () => {
  const p = file('{"a":1}\n{"b":2}\n{"c":3}\n{"partial"');
  const size = statSync(p).size;
  const r1 = readNewLines(p, 0, size, 1000);
  assert.equal(r1.text, '{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.equal(r1.next, 24);
  assert.deepEqual(readNewLines(p, r1.next, size, 1000), { text: "", next: 24 });   // half-written line waits
});

test("a byte cap drains a backlog over several runs without losing or repeating a line", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `{"domain":"s${i}.co.za"}`);
  const p = file(lines.join("\n") + "\n");
  const size = statSync(p).size;
  const got = []; let off = 0;
  for (let run = 0; run < 100 && off < size; run++) {
    const r = readNewLines(p, off, size, 100);
    got.push(...r.text.split("\n").filter(Boolean)); off = r.next;
  }
  assert.deepEqual(got, lines);
});

test("a watermark that sits mid-line skips to the next full line", () => {
  const p = file('{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.equal(readNewLines(p, 3, statSync(p).size, 1000).text, '{"b":2}\n{"c":3}\n');
  assert.equal(readNewLines(p, 8, statSync(p).size, 1000).text, '{"b":2}\n{"c":3}\n');   // on a boundary: keep it
});
