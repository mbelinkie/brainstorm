import test from "node:test";
import assert from "node:assert/strict";
import { cropRect, panCrop } from "../image-crop.js";

test("crop zoom preserves the selected aspect ratio", () => {
  const fitted = cropRect(1600, 900, 1, 0.5, 0.5, 1);
  const zoomed = cropRect(1600, 900, 1, 0.5, 0.5, 2);
  assert.deepEqual(fitted, { left: 350, top: 0, width: 900, height: 900 });
  assert.deepEqual(zoomed, { left: 575, top: 225, width: 450, height: 450 });
});

test("zoom also works when keeping the original image shape", () => {
  const zoomed = cropRect(1200, 800, null, 0.5, 0.5, 2);
  assert.deepEqual(zoomed, { left: 300, top: 200, width: 600, height: 400 });
});

test("dragging moves the image with the pointer and clamps at its edges", () => {
  const crop = { aspect: 1, focalX: 0.5, focalY: 0.5, zoom: 2 };
  const moved = panCrop(crop, 1600, 900, 100, -100, 600, 600);
  assert.ok(moved.focalX < 0.5, "dragging right should move the crop window left");
  assert.ok(moved.focalY > 0.5, "dragging up should move the crop window down");
  const clamped = panCrop(crop, 1600, 900, 100000, 100000, 600, 600);
  const rect = cropRect(1600, 900, 1, clamped.focalX, clamped.focalY, 2);
  assert.equal(rect.left, 0);
  assert.equal(rect.top, 0);
});
