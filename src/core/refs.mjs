/**
 * Remote reference/recommendation data.
 *
 * The panel's 「参考与推荐」 data lives in a public repository; this service fetches the
 * latest JSON on each `/refs` request (or within `refreshMs`), supports the GitCode Contents
 * API base64 envelope, validates the payload, and falls back to the last successful copy
 * (memory or disk) when the network is unavailable. No panel data is hardcoded here.
 */
import fs from 'node:fs';
import path from 'node:path';

import { cacheRoot } from './creators.mjs';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DOMAINS = ['ai', 'bigdata', 'computing', 'database', 'network', 'security', 'storage'];

const emptyScene = (kind) => (kind === 'huawei'
  ? { schemaVersion: 1, kind, updatedAt: '', cases: [], skillsByDomain: {} }
  : { schemaVersion: 1, kind, updatedAt: '', cases: [], skills: [] });

const isHttp = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
const text = (value) => (value == null ? '' : String(value)).trim();

function normalizeCase(item, warnings, where) {
  if (!item || typeof item !== 'object') {
    warnings.push(`${where}: case is not an object`);
    return null;
  }
  const id = text(item.id);
  const title = text(item.title);
  const desc = text(item.desc || item.description);
  if (!id || !title || !desc) {
    warnings.push(`${where}: case missing id/title/desc`);
    return null;
  }
  const out = {
    id,
    title,
    desc,
    skills: (Array.isArray(item.skills) ? item.skills : []).map(text).filter(Boolean).slice(0, 3),
  };
  if (isHttp(item.video)) out.video = item.video;
  else if (item.video) warnings.push(`${where}/${id}: ignored non-http video`);
  if (isHttp(item.image)) out.image = item.image;
  else if (item.image) warnings.push(`${where}/${id}: ignored non-http image`);
  return out;
}

function normalizeSkill(item, warnings, where) {
  if (!item || typeof item !== 'object') {
    warnings.push(`${where}: skill is not an object`);
    return null;
  }
  const id = text(item.id);
  const name = text(item.name);
  const desc = text(item.desc || item.description);
  if (!id || !name || !desc) {
    warnings.push(`${where}: skill missing id/name/desc`);
    return null;
  }
  const out = {
    id,
    name,
    cn: text(item.cn || item.name_cn),
    desc,
    tags: (Array.isArray(item.tags) ? item.tags : []).map(text).filter(Boolean).slice(0, 4),
    repo: text(item.repo),
    views: Number.isFinite(Number(item.views)) ? Math.max(0, Number(item.views)) : 0,
    l2: text(item.l2),
  };
  if (isHttp(item.url)) out.url = item.url;
  else if (item.url) warnings.push(`${where}/${id}: ignored non-http url`);
  return out;
}

/** Validate/normalize one public data file; throws only when the file envelope is unusable. */
export function normalizeReferences(kind, raw) {
  if (!raw || typeof raw !== 'object') throw new Error('references: content is not an object');
  if (raw.schemaVersion !== 1) throw new Error(`references: unsupported schemaVersion ${String(raw.schemaVersion)}`);
  if (raw.kind && raw.kind !== kind) throw new Error(`references: kind=${raw.kind} does not match ${kind}`);
  const warnings = [];
  const scene = emptyScene(kind);
  scene.updatedAt = text(raw.updatedAt);
  scene.cases = (Array.isArray(raw.cases) ? raw.cases : []).slice(0, 200)
    .map((item, index) => normalizeCase(item, warnings, `${kind}.cases[${index}]`))
    .filter(Boolean);

  if (kind === 'generic') {
    scene.skills = (Array.isArray(raw.skills) ? raw.skills : []).slice(0, 200)
      .map((item, index) => normalizeSkill(item, warnings, `${kind}.skills[${index}]`))
      .filter(Boolean);
    return { data: scene, warnings };
  }

  const byDomain = raw.skillsByDomain && typeof raw.skillsByDomain === 'object' ? raw.skillsByDomain : {};
  for (const domain of [...DOMAINS, 'default']) {
    const list = byDomain[domain];
    if (!Array.isArray(list)) continue;
    scene.skillsByDomain[domain] = list.slice(0, 100)
      .map((item, index) => normalizeSkill(item, warnings, `${kind}.${domain}[${index}]`))
      .filter(Boolean);
  }
  return { data: scene, warnings };
}

function readDisk(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.data) return null;
    return {
      data: parsed.data,
      sha: text(parsed.sha),
      fetchedAt: text(parsed.fetchedAt),
      at: Number(parsed.at) || 0,
    };
  } catch {
    return null;
  }
}

function writeDisk(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch { /* cache is best effort */ }
}

async function readResponseText(response, maxBytes) {
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response exceeds maxBytes (${declared})`);
  const textBody = await response.text();
  if (Buffer.byteLength(textBody, 'utf8') > maxBytes) throw new Error(`response exceeds maxBytes (${Buffer.byteLength(textBody, 'utf8')})`);
  return textBody;
}

/**
 * @param {object} config `refs` section: huaweiUrl/genericUrl, refreshMs, timeoutMs, maxBytes, cacheBust
 * @param {object} deps `fetch` injection for tests
 */
export function createRefs(config = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(500, Number(config.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(config.maxBytes) ? Math.max(1024, Number(config.maxBytes)) : DEFAULT_MAX_BYTES;
  const refreshMs = Number.isFinite(config.refreshMs) ? Math.max(0, Number(config.refreshMs)) : 0;
  const cacheBust = config.cacheBust === true;
  const memory = new Map();
  const cacheDir = path.join(cacheRoot(), 'references');
  const cacheFile = (kind) => path.join(cacheDir, `${kind}.json`);

  const urlFor = (kind) => text(config[`${kind}Url`] || config[`${kind}Path`]);

  async function fetchOne(kind) {
    const url = urlFor(kind);
    if (!url) return { source: 'none', stale: true, data: emptyScene(kind), warnings: [`${kind}: refs URL not configured`] };
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return { source: 'none', stale: true, data: emptyScene(kind), warnings: [`${kind}: invalid refs URL`] }; }
    if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && /^(?:localhost|127\.0\.0\.1)$/i.test(parsedUrl.hostname))) {
      return { source: 'none', stale: true, data: emptyScene(kind), warnings: [`${kind}: only https refs URLs are allowed`] };
    }
    const cachedMemory = memory.get(kind);
    if (refreshMs > 0 && cachedMemory && Date.now() - cachedMemory.at < refreshMs) {
      return { source: 'cache', stale: false, ...cachedMemory, warnings: [] };
    }
    if (typeof fetchImpl !== 'function') {
      return { source: 'none', stale: true, data: emptyScene(kind), warnings: [`${kind}: fetch is unavailable`] };
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      if (cacheBust) parsedUrl.searchParams.set('_', String(Date.now()));
      const response = await fetchImpl(parsedUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'scenes-skill-creator/refs' },
        signal: controller ? controller.signal : undefined,
        cache: 'no-store',
      });
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : 'no response'}`);
      const bodyText = await readResponseText(response, maxBytes);
      let body = JSON.parse(bodyText);
      let sha = '';
      if (body && typeof body === 'object' && body.encoding === 'base64' && typeof body.content === 'string') {
        // GitCode Contents API: raw URLs of a non-default branch are not anonymously readable.
        sha = text(body.sha);
        body = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      }
      const { data, warnings } = normalizeReferences(kind, body);
      const record = { data, sha, fetchedAt: new Date().toISOString(), at: Date.now() };
      memory.set(kind, record);
      writeDisk(cacheFile(kind), record);
      return { source: 'remote', stale: false, ...record, warnings };
    } catch (error) {
      const fallback = cachedMemory || readDisk(cacheFile(kind));
      if (fallback) {
        memory.set(kind, fallback);
        return {
          source: 'cache', stale: true, ...fallback,
          warnings: [`${kind}: remote refs unavailable (${String((error && error.message) || error)})`],
        };
      }
      return {
        source: 'none', stale: true, data: emptyScene(kind),
        warnings: [`${kind}: remote refs unavailable (${String((error && error.message) || error)})`],
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function snapshot() {
    const [huawei, generic] = await Promise.all([fetchOne('huawei'), fetchOne('generic')]);
    const warnings = [...huawei.warnings, ...generic.warnings];
    const sources = { huawei: huawei.source, generic: generic.source };
    const source = Object.values(sources).every((item) => item === 'remote') ? 'remote'
      : Object.values(sources).some((item) => item === 'cache') ? 'cache' : 'none';
    return {
      ok: true,
      source,
      stale: Boolean(huawei.stale || generic.stale),
      fetchedAt: new Date().toISOString(),
      sources,
      scenes: { huawei: huawei.data, generic: generic.data },
      warnings,
    };
  }

  return { snapshot };
}