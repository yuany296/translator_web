import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {},
    storage: { local: {} }
  },
  console,
  fetch,
  URL,
  Blob,
  AbortController,
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__bg = MtBackgroundModule.backgroundRuntime;`, context, { filename: "background.iife.js" });
const rt = context.__bg;

function polygonFromCenter(center, axisLen, thickness, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  const ax = Math.cos(rad), ay = Math.sin(rad);
  const nx = -ay, ny = ax;
  return [
    { x: center.x - ax * axisLen / 2 + nx * thickness / 2, y: center.y - ay * axisLen / 2 + ny * thickness / 2 },
    { x: center.x + ax * axisLen / 2 + nx * thickness / 2, y: center.y + ay * axisLen / 2 + ny * thickness / 2 },
    { x: center.x + ax * axisLen / 2 - nx * thickness / 2, y: center.y + ay * axisLen / 2 - ny * thickness / 2 },
    { x: center.x - ax * axisLen / 2 - nx * thickness / 2, y: center.y - ay * axisLen / 2 - ny * thickness / 2 }
  ];
}

test("projectPointToAxes / unprojectPointFromAxes roundtrip", () => {
  const point = { x: 350, y: 220 };
  const angle = -14;
  const proj = rt.projectPointToAxes(point, angle);
  const back = rt.unprojectPointFromAxes(proj.u, proj.v, angle);
  assert.ok(Math.abs(back.x - point.x) < 1e-9);
  assert.ok(Math.abs(back.y - point.y) < 1e-9);
});

test("projectPointToAxes at 0° keeps x as u and y as v", () => {
  const p = { x: 100, y: 200 };
  const r = rt.projectPointToAxes(p, 0);
  assert.ok(Math.abs(r.u - 100) < 1e-9);
  assert.ok(Math.abs(r.v - 200) < 1e-9);
});

test("buildOrientedDebugPolygon at 0° matches AABB", () => {
  const members = [{
    item: { polygon: polygonFromCenter({ x: 200, y: 100 }, 160, 40, 0) }
  }, {
    item: { polygon: polygonFromCenter({ x: 360, y: 100 }, 180, 42, 0) }
  }];
  const img = { width: 800, height: 600 };
  const poly = rt.buildOrientedDebugPolygon(members, 0, img);
  assert.ok(Array.isArray(poly) && poly.length === 4);
  assert.ok(poly.every(p => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100));
  // At 0° the OBB should be nearly horizontal
  const ys = poly.map(p => p.y);
  const yRange = Math.max(...ys) - Math.min(...ys);
  assert.ok(yRange < 12, `0° OBB y-range ${yRange.toFixed(1)} should be small (text height)`);
});

test("buildOrientedDebugPolygon at -14° is oriented not AABB-expanded", () => {
  // Two members on the same tilted text line (same local v-coordinate)
  const angle = -14;
  const rad = angle * Math.PI / 180;
  // Center1 at (200, 180), compute v = -x*sin(θ) + y*cos(θ) ≈ -200*(-0.242) + 180*0.970 = 48.4 + 174.6 = 223.0
  // For center2 at x=380, solve for y such that v is same:
  // -380*(-0.242) + y*0.970 = 223.0 → 91.96 + y*0.970 = 223.0 → y = (223-91.96)/0.97 = 135.1
  const cx1 = 200, cy1 = 180;
  const cx2 = 380;
  const v1 = -cx1 * Math.sin(rad) + cy1 * Math.cos(rad);
  const cy2 = (v1 + cx2 * Math.sin(rad)) / Math.cos(rad);
  const members = [
    { item: { polygon: polygonFromCenter({ x: cx1, y: cy1 }, 160, 28, angle) } },
    { item: { polygon: polygonFromCenter({ x: cx2, y: cy2 }, 140, 30, angle) } }
  ];
  const img = { width: 800, height: 600 };
  const poly = rt.buildOrientedDebugPolygon(members, angle, img);
  assert.ok(poly.length === 4);
  const proj = poly.map(p => rt.projectPointToAxes(p, angle));
  const localW = Math.max(...proj.map(p => p.u)) - Math.min(...proj.map(p => p.u));
  const localH = Math.max(...proj.map(p => p.v)) - Math.min(...proj.map(p => p.v));
  // Local height should be close to text height (~30px → ~5% of 600)
  assert.ok(localH < 10, `local height ${localH.toFixed(1)} should be < 10% (text height)`);
  assert.ok(localW > 10, `local width ${localW.toFixed(1)} should have width`);
  // World AABB height vs local height — local should be much smaller
  const worldH = (Math.max(...poly.map(p => p.y)) - Math.min(...poly.map(p => p.y)));
  assert.ok(localH < worldH * 0.8, `localH ${localH.toFixed(1)} < worldH ${worldH.toFixed(1)} (tilted, no AABB bloat)`);
});

test("buildOrientedDebugPolygon two lines — covers only those two", () => {
  const angle = -14;
  const rad = angle * Math.PI / 180;
  const cx1 = 200, cy1 = 100;
  const v1 = -cx1 * Math.sin(rad) + cy1 * Math.cos(rad);
  const cx2 = 390;
  const cy2 = (v1 + cx2 * Math.sin(rad)) / Math.cos(rad);
  const members = [
    { item: { polygon: polygonFromCenter({ x: cx1, y: cy1 }, 160, 28, angle) } },
    { item: { polygon: polygonFromCenter({ x: cx2, y: cy2 }, 150, 30, angle) } }
  ];
  const img = { width: 800, height: 600 };
  const poly = rt.buildOrientedDebugPolygon(members, angle, img);
  const proj = poly.map(p => rt.projectPointToAxes(p, angle));
  const localH = Math.max(...proj.map(p => p.v)) - Math.min(...proj.map(p => p.v));
  // Single text line should be ~30px → ~5% of 600
  assert.ok(localH < 10, `two-line OBB height ${localH.toFixed(1)} should be one-line height`);
});

test("adjacent paragraphs do not merge into one big OBB", () => {
  const angle = -14;
  const rad = angle * Math.PI / 180;
  // Paragraph A — two lines at same v using same-angle alignment
  const cxA1 = 140, cyA1 = 90;
  const vA1 = -cxA1 * Math.sin(rad) + cyA1 * Math.cos(rad);
  const cxA2 = 170;
  const cyA2 = (vA1 + cxA2 * Math.sin(rad)) / Math.cos(rad);
  const paraA = [
    { item: { polygon: polygonFromCenter({ x: cxA1, y: cyA1 }, 140, 24, angle) } },
    { item: { polygon: polygonFromCenter({ x: cxA2, y: cyA2 }, 260, 34, angle) } }
  ];
  // Paragraph B — another line well below in local v
  const cxB1 = 140, cyB1 = 240;
  const vB1 = -cxB1 * Math.sin(rad) + cyB1 * Math.cos(rad);
  const cxB2 = 170;
  const cyB2 = (vB1 + cxB2 * Math.sin(rad)) / Math.cos(rad);
  const paraB = [
    { item: { polygon: polygonFromCenter({ x: cxB1, y: cyB1 }, 140, 24, angle) } },
    { item: { polygon: polygonFromCenter({ x: cxB2, y: cyB2 }, 260, 34, angle) } }
  ];
  const img = { width: 800, height: 600 };
  const polyA = rt.buildOrientedDebugPolygon(paraA, angle, img);
  const polyB = rt.buildOrientedDebugPolygon(paraB, angle, img);
  const getLocalRange = poly => {
    const p = poly.map(pt => rt.projectPointToAxes(pt, angle));
    return { minV: Math.min(...p.map(q => q.v)), maxV: Math.max(...p.map(q => q.v)) };
  };
  const rangeA = getLocalRange(polyA);
  const rangeB = getLocalRange(polyB);
  assert.ok(rangeB.minV > rangeA.maxV, `B.minV ${rangeB.minV.toFixed(1)} > A.maxV ${rangeA.maxV.toFixed(1)}`);
});

test("buildOrientedDebugPolygon fallback — members with no polygon", () => {
  const members = [
    { item: { location: { left: 100, top: 80, width: 300, height: 40 } } },
    { item: { location: { left: 110, top: 135, width: 280, height: 38 } } }
  ];
  const img = { width: 800, height: 600 };
  const poly = rt.buildOrientedDebugPolygon(members, -14, img);
  assert.ok(poly.length === 4);
  assert.ok(poly.every(p => p.x >= 0 && p.x <= 100));
  // Should produce a valid oriented rect from the AABB center
  const proj = poly.map(p => rt.projectPointToAxes(p, -14));
  const localW = Math.max(...proj.map(p => p.u)) - Math.min(...proj.map(p => p.u));
  const localH = Math.max(...proj.map(p => p.v)) - Math.min(...proj.map(p => p.v));
  assert.ok(localW > 0 && localH > 0, "fallback OBB has positive dimensions");
});

test("buildOrientedDebugPolygon order stability", () => {
  const angle = -8;
  const rad = angle * Math.PI / 180;
  const cx1 = 200, cy1 = 120;
  const v1 = -cx1 * Math.sin(rad) + cy1 * Math.cos(rad);
  const cx2 = 360;
  const cy2 = (v1 + cx2 * Math.sin(rad)) / Math.cos(rad);
  const members = [
    { item: { polygon: polygonFromCenter({ x: cx1, y: cy1 }, 160, 30, angle) } },
    { item: { polygon: polygonFromCenter({ x: cx2, y: cy2 }, 140, 28, angle) } }
  ];
  const img = { width: 800, height: 600 };
  const polyA = rt.buildOrientedDebugPolygon(members, angle, img);
  const polyB = rt.buildOrientedDebugPolygon([...members].reverse(), angle, img);
  // Should produce same polygon regardless of member order
  const key = poly => poly.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join("|");
  assert.strictEqual(key(polyA), key(polyB));
});

test("collectMemberPolygonPoints with missing items", () => {
  const members = [
    null,
    { item: null },
    { item: { polygon: null } },
    { item: { polygon: polygonFromCenter({ x: 100, y: 50 }, 80, 20, 0) } }
  ];
  const points = rt.collectMemberPolygonPoints(members);
  assert.ok(points.length === 4, `should collect 4 points from 1 valid member, got ${points.length}`);
});
