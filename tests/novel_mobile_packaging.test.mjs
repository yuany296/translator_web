import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createCrx, createZip, crc32, extensionIdFromPublicKey, packNovelMobile, publicKeyDerFromPem, readZip, verifyCrx
} from "../scripts/pack-novel-mobile.mjs";

// 打包器测试：zip 与 CRX3 都是手写容器格式，必须自己把结构、CRC、签名和
// 「解压安装与 crx 安装同一个扩展 ID」这几件事钉住。不依赖任何构建产物。
const root = path.resolve(import.meta.dirname, "..");
const workDir = path.join(root, "dist", ".pack-test");

function makeKey() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  }).privateKey;
}

test("zip：目录、嵌套路径、中文文件名、可压缩与不可压缩内容都能原样读回", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"manifest_version":3}') },
    { name: "icons/", data: Buffer.alloc(0) },
    { name: "assets/floating-actions/小说翻译_圆形图标.png", data: crypto.randomBytes(64) },
    { name: "content.js", data: Buffer.from("const a = 1;\n".repeat(500)) }
  ];
  const zip = createZip(entries);
  assert.equal(zip.subarray(0, 4).toString("hex"), "504b0304");
  const read = readZip(zip);
  // createZip 保持传入顺序（真实打包时由 collectFiles 先排好序）
  assert.deepEqual(read.map(entry => entry.name), [
    "manifest.json", "icons/", "assets/floating-actions/小说翻译_圆形图标.png", "content.js"
  ]);
  read.forEach(entry => {
    const expected = entries.find(item => item.name === entry.name);
    assert.equal(entry.data.equals(expected.data), true, `${entry.name} 内容不一致`);
  });
  // 大文件走 deflate，小文件走 store：两种 method 都要能被读回
  assert.equal(read.find(entry => entry.name === "content.js").method, 8);
  assert.ok(read.find(entry => entry.name === "content.js").size < 500 * 14);
  assert.equal(read.find(entry => entry.name === "manifest.json").method, 0);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "CRC32 要与标准测试向量一致");
});

test("crx：容器结构、crx_id 与 RSA 签名都能独立复核", () => {
  const key = makeKey();
  const zip = createZip([{ name: "manifest.json", data: Buffer.from("{}") }]);
  const crx = createCrx(zip, key);
  assert.equal(crx.subarray(0, 4).toString("latin1"), "Cr24");
  assert.equal(crx.readUInt32LE(4), 3);
  const headerLength = crx.readUInt32LE(8);
  assert.equal(crx.subarray(12 + headerLength, 16 + headerLength).toString("hex"), "504b0304", "头部之后必须紧跟 zip");
  const verified = verifyCrx(crx);
  assert.equal(verified.ok, true, verified.error);
  const publicKeyDer = publicKeyDerFromPem(key);
  assert.equal(verified.publicKeyDer.equals(publicKeyDer), true);
  assert.equal(verified.extensionId, extensionIdFromPublicKey(publicKeyDer));
  assert.match(verified.extensionId, /^[a-p]{32}$/u);
  assert.equal(verified.zipBuffer.equals(zip), true);
});

test("crx：同一个密钥与 zip 打两次逐字节相同（PKCS#1 v1.5 是确定性签名）", () => {
  const key = makeKey();
  const zip = createZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  assert.equal(createCrx(zip, key).equals(createCrx(zip, key)), true);
});

test("crx：篡改 zip 或签名都会被自检拦下", () => {
  const key = makeKey();
  const zip = createZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  const crx = createCrx(zip, key);
  const tampered = Buffer.from(crx);
  tampered[tampered.length - 1] ^= 0xff;
  assert.equal(verifyCrx(tampered).ok, false);
  const headerLength = crx.readUInt32LE(8);
  const brokenHeader = Buffer.from(crx);
  brokenHeader[12 + 2] ^= 0xff;
  assert.equal(verifyCrx(brokenHeader).ok, false, `头部被改坏也要失败（headerLength=${headerLength}）`);
  assert.equal(verifyCrx(Buffer.from("not-a-crx")).ok, false);
});

test("打包：产出 zip + crx；默认不动 manifest，加 --with-key 才注入公钥", () => {
  const sourceDir = path.join(workDir, "src");
  const outDir = path.join(workDir, "out");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(sourceDir, "icons"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x" }));
  fs.writeFileSync(path.join(sourceDir, "icons", "i.png"), crypto.randomBytes(32));
  const readManifest = () => JSON.parse(readZip(fs.readFileSync(path.join(outDir, "novel-mobile.zip")))
    .find(entry => entry.name === "manifest.json").data.toString("utf8"));
  try {
    const result = packNovelMobile({
      sourceDir,
      outDir,
      keyPath: path.join(workDir, "keys", "test.pem"),
      log: () => {}
    });
    assert.equal(fs.existsSync(result.zipPath), true);
    assert.equal(fs.existsSync(result.crxPath), true);
    assert.equal(fs.existsSync(result.keyPath), true);
    const zipEntries = readZip(fs.readFileSync(result.zipPath));
    assert.deepEqual(zipEntries.map(entry => entry.name), ["icons/", "icons/i.png", "manifest.json"]);
    // manifest 必须在压缩包根目录，否则 Edge/Chrome 会拒绝加载
    assert.ok(zipEntries.some(entry => entry.name === "manifest.json"));
    assert.equal(readManifest().key, undefined, "默认不改 manifest：Chrome 自带打包器要用它自己的密钥");
    assert.equal(verifyCrx(fs.readFileSync(result.crxPath)).ok, true);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("打包：--with-key 注入的公钥与 crx 公钥一致（解压安装与 crx 安装同一个 ID）", () => {
  const sourceDir = path.join(workDir, "src");
  const outDir = path.join(workDir, "out");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x" }));
  const keyPath = path.join(workDir, "keys", "test.pem");
  try {
    const result = packNovelMobile({ sourceDir, outDir, keyPath, withKey: true, log: () => {} });
    const zippedManifest = JSON.parse(readZip(fs.readFileSync(result.zipPath))
      .find(entry => entry.name === "manifest.json").data.toString("utf8"));
    const verified = verifyCrx(fs.readFileSync(result.crxPath));
    assert.equal(verified.ok, true, verified.error);
    assert.equal(Buffer.from(zippedManifest.key, "base64").equals(verified.publicKeyDer), true,
      "manifest.key 必须等于 crx 公钥，两种装法才会是同一个扩展 ID");
    assert.equal(result.extensionId, verified.extensionId);
    const again = packNovelMobile({ sourceDir, outDir, keyPath, withKey: true, log: () => {} });
    assert.equal(again.extensionId, result.extensionId, "沿用同一密钥时扩展 ID 必须稳定");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("打包：manifest 里的 key 与签名密钥不一致时立刻报错，而不是产出迷惑产物", () => {
  const sourceDir = path.join(workDir, "src");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    key: crypto.randomBytes(294).toString("base64")
  }));
  try {
    assert.throws(
      () => packNovelMobile({ sourceDir, outDir: path.join(workDir, "out"), keyPath: path.join(workDir, "k.pem") }),
      /先跑 node scripts\/build-novel-mobile\.mjs/u
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("打包：目录不是手机版产物时给出可操作的报错", () => {
  const emptyDir = path.join(workDir, "empty");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(emptyDir, { recursive: true });
  try {
    assert.throws(
      () => packNovelMobile({ sourceDir: emptyDir, outDir: path.join(workDir, "out"), keyPath: path.join(workDir, "k.pem") }),
      /先跑 node scripts\/build-novel-mobile\.mjs/u
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
