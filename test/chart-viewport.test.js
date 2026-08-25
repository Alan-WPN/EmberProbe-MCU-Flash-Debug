"use strict";
const assert = require("assert");
const viewport = require("../src/webview/liveWatch/viewport");

function close(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

const source = { min: 0, max: 100 };
const anchored = viewport.zoom(source, 0.5, 25, 1);
close(anchored.min, 12.5, "anchored zoom should preserve the anchor ratio");
close(anchored.max, 62.5, "anchored zoom should preserve the anchor ratio");
close((25 - anchored.min) / viewport.span(anchored), 0.25, "anchor should stay at the same screen position");

const centered = viewport.zoomCentered({ min: -50, max: 50 }, 0.5, 1);
close(centered.min, -25, "centered zoom should keep the Y center fixed");
close(centered.max, 25, "centered zoom should keep the Y center fixed");

assert.deepStrictEqual(
    viewport.panClamped({ min: 20, max: 60 }, 70, { min: 0, max: 100 }, 1),
    { min: 60, max: 100 },
    "panning past the right bound should preserve width"
);
assert.deepStrictEqual(
    viewport.clamp({ min: -30, max: 130 }, { min: 0, max: 100 }, 1),
    { min: 0, max: 100 },
    "an oversized range should collapse to all retained data"
);

const minimum = viewport.zoom({ min: 0, max: 100 }, 1e-20, 50, 2);
close(viewport.span(minimum), 2, "zoom should respect the numerical minimum span");
assert.ok(Number.isFinite(minimum.min) && Number.isFinite(minimum.max), "extreme zoom should remain finite");

assert.deepStrictEqual(
    viewport.updateEndpoint({ min: 20, max: 80 }, "min", 95, { min: 0, max: 100 }, 5),
    { min: 75, max: 80 },
    "timeline endpoints must not cross"
);
assert.deepStrictEqual(
    viewport.updateEndpoint({ min: 20, max: 80 }, "max", 5, { min: 0, max: 100 }, 5),
    { min: 20, max: 25 },
    "timeline endpoints must not cross"
);

const percentages = viewport.toPercent({ min: 25, max: 75 }, { min: 0, max: 100 });
close(percentages.left, 25, "timeline selection should map to the correct offset");
close(percentages.width, 50, "timeline selection should map to the correct width");

assert.strictEqual(viewport.isAtEnd({ min: 40, max: 99 }, { min: 0, max: 100 }, 1), true);
assert.strictEqual(viewport.isAtEnd({ min: 40, max: 95 }, { min: 0, max: 100 }, 1), false);
assert.deepStrictEqual(
    viewport.followEnd({ min: 60, max: 100 }, { min: 0, max: 100 }, { min: 10, max: 120 }, 1),
    { min: 80, max: 120 },
    "following should preserve width and attach the range to the newest sample"
);

console.log("Chart viewport tests passed");
