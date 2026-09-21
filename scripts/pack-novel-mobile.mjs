import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

/**
 * 把 dist/novel-mobile 打包成 .crx（CRX3）与 .zip。
 *
 * 为什么两个都要：
 *   - Edge Canary 安卓的侧载入口是「设置 → 开发者选项 → 通过 crx 安装扩展」，只吃 .crx；
 *   - Kiwi / 狐猴 / Mises 等更常吃「解压后的目录」或 .zip；
 *   - .zip 还能当备份（换浏览器、存档都行）。
 *
 * CRX3 容器格式照 Chromium 的 components/crx_file/crx3.proto 实现：
 *   "Cr24" | uint32LE(3) | uint32LE(header 长度) | CrxFileHeader(protobuf) | zip
 * 签名是 RSA PKCS#1 v1.5 + SHA-256，签的内容是
 *   "CRX3 SignedData\0" | uint32LE(signed_header_data 长度) | signed_header_data | zip
 * 其中 signed_header_data 是 SignedData{crx_id}，crx_id = SHA256(公钥 SPKI DER) 前 16 字节。
 * （proto 里把算法注释成 PSS 是文档笔误，事实标准实现都用 Node 默认的 PKCS#1 v1.5。）
 */

const CRX_MAGIC = Buffer.from("Cr24", "latin1");
const CRX_VERSION = 3;
const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\x00", "latin1");
const CRX_ID_SIZE = 16;
const ZIP_UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const STORE_METHOD = 0;
// 固定 DOS 时间戳：同一份产物重复打包会得到逐字节相同的 zip / crx，便于比对与复现。
const DOS_DATE = 0x2821;
const DOS_TIME = 0;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

// ── protobuf：只需要「长度分隔的 bytes 字段」这一种子集 ──

function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function bytesField(field, payload) {
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

function readVarint(buffer, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    value |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("protobuf varint 越界");
}

function readBytesFields(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire !== 2) throw new Error(`protobuf 只支持长度分隔字段，遇到 wire=${wire}`);
    const length = readVarint(buffer, offset);
    offset = length.offset;
    fields.set(field, buffer.subarray(offset, offset + length.value));
    offset += length.value;
  }
  return fields;
}

// ── 扩展 ID ──

/** Chrome/Edge 的扩展 ID：公钥 SPKI DER 的 SHA-256 前 16 字节，每字节映射成 a-p 两个字母。 */
export function extensionIdFromPublicKey(publicKeyDer) {
  const hash = crypto.createHash("sha256").update(publicKeyDer).digest();
  return [...hash.subarray(0, CRX_ID_SIZE)]
    .map(byte => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f)))
    .join("");
}

export function publicKeyDerFromPem(privateKeyPem) {
  return crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
}

// ── ZIP ──

export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const isDirectory = entry.name.endsWith("/");
    const deflated = isDirectory ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = !isDirectory && deflated.length < raw.length;
    const payload = isDirectory ? Buffer.alloc(0) : useDeflate ? deflated : raw;
    const method = useDeflate ? DEFLATE_METHOD : STORE_METHOD;
    const crc = isDirectory ? 0 : crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(isDirectory ? 0 : raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(isDirectory ? 0 : raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

/** 读回 zip（也用来在打包后自检）：返回每个条目的名字与内容。 */
export function readZip(buffer) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error("找不到 zip 结尾记录（EOCD）");
  const count = buffer.readUInt16LE(endOffset + 10);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("中央目录记录损坏");
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === DEFLATE_METHOD ? zlib.inflateRawSync(payload) : payload;
    if (crc && crc32(data) !== crc) throw new Error(`条目 CRC 校验失败：${name}`);
    entries.push({ name, data, method, size: data.length });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ── CRX3 ──

export function createCrx(zipBuffer, privateKeyPem) {
  const publicKeyDer = publicKeyDerFromPem(privateKeyPem);
  const crxId = crypto.createHash("sha256").update(publicKeyDer).digest().subarray(0, CRX_ID_SIZE);
  const signedHeaderData = bytesField(1, crxId);
  const sizeOctets = Buffer.alloc(4);
  sizeOctets.writeUInt32LE(signedHeaderData.length, 0);
  const signer = crypto.createSign("sha256");
  signer.update(SIGNATURE_CONTEXT);
  signer.update(sizeOctets);
  signer.update(signedHeaderData);
  signer.update(zipBuffer);
  const signature = signer.sign(privateKeyPem);
  const proof = Buffer.concat([bytesField(1, publicKeyDer), bytesField(2, signature)]);
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedHeaderData)]);
  const prefix = Buffer.alloc(12);
  CRX_MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(CRX_VERSION, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zipBuffer]);
}

/** 打包后自检：容器结构 + protobuf 字段 + crx_id + RSA 签名，全部按规范独立复核一遍。 */
export function verifyCrx(crxBuffer) {
  if (!crxBuffer.subarray(0, 4).equals(CRX_MAGIC)) return { ok: false, error: "magic 不是 Cr24" };
  if (crxBuffer.readUInt32LE(4) !== CRX_VERSION) return { ok: false, error: "版本不是 3" };
  const headerLength = crxBuffer.readUInt32LE(8);
  const header = crxBuffer.subarray(12, 12 + headerLength);
  const zipBuffer = crxBuffer.subarray(12 + headerLength);
  let fields;
  let proof;
  try {
    fields = readBytesFields(header);
    proof = readBytesFields(fields.get(2) || Buffer.alloc(0));
  } catch (error) {
    return { ok: false, error: `头部解析失败：${error.message}` };
  }
  const publicKeyDer = proof.get(1);
  const signature = proof.get(2);
  const signedHeaderData = fields.get(10000);
  if (!publicKeyDer || !signature || !signedHeaderData) return { ok: false, error: "头部字段缺失" };
  const expectedId = crypto.createHash("sha256").update(publicKeyDer).digest().subarray(0, CRX_ID_SIZE);
  if (!readBytesFields(signedHeaderData).get(1).equals(expectedId)) {
    return { ok: false, error: "signed_header_data 里的 crx_id 与公钥不符" };
  }
  const sizeOctets = Buffer.alloc(4);
  sizeOctets.writeUInt32LE(signedHeaderData.length, 0);
  const verifier = crypto.createVerify("sha256");
  verifier.update(SIGNATURE_CONTEXT);
  verifier.update(sizeOctets);
  verifier.update(signedHeaderData);
  verifier.update(zipBuffer);
  const verifyKey = crypto.createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  if (!verifier.verify(verifyKey, signature)) return { ok: false, error: "RSA 签名校验失败" };
  return { ok: true, publicKeyDer, zipBuffer, extensionId: extensionIdFromPublicKey(publicKeyDer) };
}

// ── 打包 ──

function collectFiles(root, base = "") {
  const entries = [];
  for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      entries.push({ name: `${relative}/`, data: Buffer.alloc(0) });
      entries.push(...collectFiles(root, relative));
    } else {
      entries.push({ name: relative, data: fs.readFileSync(path.join(root, relative)) });
    }
  }
  return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function loadOrCreateKey(keyPath) {
  if (fs.existsSync(keyPath)) return { pem: fs.readFileSync(keyPath, "utf8"), created: false };
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  return { pem: privateKey, created: true };
}

function injectManifestKey(sourceDir, publicKeyDer) {
  const manifestPath = path.join(sourceDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.key = publicKeyDer.toString("base64");
  // 固定为签名密钥对应的公钥，让「解压目录安装」和「crx 安装」拿到同一个扩展 ID：
  // 否则两者 ID 不同，chrome.storage 里的术语库和 IndexedDB 里的译文缓存会看起来「丢了」。
  // 注意：这只对「本脚本产出的 crx」成立；用 Chrome/Edge 自带打包器时需要重新构建清掉这个字段。
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * manifest 里的 `key` 与本次签名密钥不一致时必须停下来说清楚。
 *
 * crx 安装用的是 crx 里的公钥，manifest 的 `key` 只影响解压安装；两者不一致不会报错，
 * 但会让同一份代码在两种装法下变成两个扩展 ID，浏览器里的术语库/缓存看起来就丢了 ——
 * 这种「不报错但结果很迷惑」比直接失败难查得多。
 */
function assertManifestKeyMatches(sourceDir, publicKeyDer) {
  const manifestPath = path.join(sourceDir, "manifest.json");
  const declared = JSON.parse(fs.readFileSync(manifestPath, "utf8")).key;
  if (!declared) return;
  if (Buffer.from(String(declared), "base64").equals(publicKeyDer)) return;
  throw new Error(
    "dist/novel-mobile/manifest.json 里的 key 与本次签名密钥不一致。"
    + "先跑 node scripts/build-novel-mobile.mjs 重新生成（清掉注入的 key），"
    + "或用 chrome://extensions 自带打包器时选同一把 .pem。"
  );
}

export function packNovelMobile({ sourceDir, outDir, keyPath, withKey = false, log = () => {} }) {
  if (!fs.existsSync(path.join(sourceDir, "manifest.json"))) {
    throw new Error(`产物目录里没有 manifest.json：${sourceDir}（先跑 node scripts/build-novel-mobile.mjs）`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const key = loadOrCreateKey(keyPath);
  const publicKeyDer = publicKeyDerFromPem(key.pem);
  assertManifestKeyMatches(sourceDir, publicKeyDer);
  if (withKey) injectManifestKey(sourceDir, publicKeyDer);
  const entries = collectFiles(sourceDir);
  const zipBuffer = createZip(entries);
  const crxBuffer = createCrx(zipBuffer, key.pem);
  const zipPath = path.join(outDir, "novel-mobile.zip");
  const crxPath = path.join(outDir, "novel-mobile.crx");
  fs.writeFileSync(zipPath, zipBuffer);
  fs.writeFileSync(crxPath, crxBuffer);
  const zipped = readZip(zipBuffer);
  const verified = verifyCrx(crxBuffer);
  if (!verified.ok) throw new Error(`CRX 自检失败：${verified.error}`);
  log(`扩展 ID：${verified.extensionId}`);
  log(`签名密钥：${keyPath}${key.created ? "（本次新生成，请备份：换掉它扩展 ID 会变，浏览器里的术语库与译文缓存会看起来丢失）" : "（沿用已有密钥）"}`);
  log(`zip：${zipPath}（${zipped.length} 个条目，${(zipBuffer.length / 1024).toFixed(0)} KB）`);
  log(`crx：${crxPath}（${(crxBuffer.length / 1024).toFixed(0)} KB，CRX3 签名自检通过）`);
  return { zipPath, crxPath, keyPath, extensionId: verified.extensionId, entries: zipped.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const withKey = process.argv.includes("--with-key");
  try {
    packNovelMobile({
      sourceDir: path.join(root, "dist", "novel-mobile"),
      outDir: path.join(root, "dist"),
      keyPath: path.join(root, "dist", "keys", "novel-mobile.pem"),
      withKey,
      log: message => console.log(message)
    });
    if (!withKey) {
      console.log("未改动 manifest.json（默认不注入 key）：这样用 Chrome/Edge 自带打包器也不会撞密钥。");
      console.log("想让「解压目录安装」与「本脚本的 crx」共用同一个扩展 ID，就加 --with-key 再打一次。");
    }
  } catch (error) {
    console.error(`打包失败：${error.message}`);
    process.exitCode = 1;
  }
}
