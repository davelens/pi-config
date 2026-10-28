import assert from "node:assert/strict";
import { collapseLeadingBlanks, condenseStep } from "../extensions/condensed/format.ts";

const time = new Date(2026, 9, 28, 11, 54);

assert.equal(
  condenseStep("26/52 areas are fully equal. Checking that with a canonical-order comparison:", time),
  "[11:54] 26/52 areas are fully equal. **Checking that with a canonical-order comparison**.",
);
assert.equal(
  condenseStep("Storage.url/1 adds the asset_host. Checking its callers before deciding where to fix:", time),
  "[11:54] Storage.url/1 adds the asset_host. **Checking its callers before deciding where to fix**.",
);
assert.equal(condenseStep("Line one.\nTracing where that comes from:", time), "[11:54] Line one.\n**Tracing where that comes from**.");
assert.equal(condenseStep("Tracing where that comes from:", time, false), "[11:54] Tracing where that comes from:");
assert.equal(condenseStep("Done. All tests pass.", time), "[11:54] Done. All tests pass.");
assert.equal(condenseStep("- item one\n- item two", time), "[11:54]\n\n- item one\n- item two");
assert.equal(condenseStep("## Summary\n\nDone.", time), "[11:54]\n\n## Summary\n\nDone.");

assert.deepEqual(collapseLeadingBlanks([""]), []);
assert.deepEqual(collapseLeadingBlanks(["\x1b]133;A\x07", "  \x1b[0m", ""]), []);
assert.deepEqual(collapseLeadingBlanks(["\x1b]133;A\x07", "", "", " Done."]), ["\x1b]133;A\x07", " Done."]);
const untouched = ["", " Done.", "", " More."];
assert.equal(collapseLeadingBlanks(untouched), untouched);

console.log("condensed test passed");
