/**
 * 抓取一级页面文本内容，生成 html.md 文档（供大模型读取）。
 *
 * 用法: node scripts/generate-html-md.mjs
 * 环境变量:
 *   BASE_URL    - 本地预览地址，默认 http://127.0.0.1:4173
 *   OUTPUT_DIR  - 输出目录，默认 ./dist/html-md
 *   DIST_DIR    - 静态站点目录，默认 ./dist
 *   PLAYWRIGHT_MODULE_PATH - Playwright 模块路径（CI 临时目录安装时使用）
 *
 * ⚠️ 此文件由 gitflow 工具自动生成。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH || 'playwright';
const { chromium } = require(playwrightPath);

const __dirname   = dirname(fileURLToPath(import.meta.url));
const routesPath  = resolve(__dirname, '..', 'src/routes.tsx');
const BASE_URL    = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/+$/, '');
const OUTPUT_DIR  = process.env.OUTPUT_DIR || './dist/html-md';
const DIST_DIR    = process.env.DIST_DIR || './dist';
const PREVIEW_PORT = new URL(BASE_URL).port || '4173';

// ── 解析路由 ──
const content = readFileSync(routesPath, 'utf-8');
const routeArrayRegex = /export\s+const\s+routes[\s\S]*?=\s*\[([\s\S]*?)\];/;
let arrayMatch = routeArrayRegex.exec(content);
if (!arrayMatch) {
  arrayMatch = /createBrowserRouter\s*\(\s*\[([\s\S]*?)\](?=\s*[,\)])/.exec(content);
}

if (!arrayMatch) {
  console.error('✗ 未能找到路由定义数组');
  process.exit(1);
}

const pathRegex = /path\s*:\s*['"`]([^'"`]+)['"`]/g;
const allPaths = [];
let match;
while ((match = pathRegex.exec(arrayMatch[1])) !== null) {
  const p = match[1];
  if (p === '*' || p === '/*' || p.includes(':')) continue;
  allPaths.push(p);
}

/** 一级页面: / 或 /segment（不含子路径） */
function isFirstLevel(path) {
  if (path === '/') return true;
  const segs = path.split('/').filter(Boolean);
  return segs.length === 1;
}

const paths = allPaths.filter(isFirstLevel);
if (paths.length === 0) {
  console.error('✗ 未找到一级页面路由');
  process.exit(1);
}

console.log(`📋 一级页面 (${paths.length}): ${paths.join(', ')}`);

/** 路由路径 → 文件名 */
function pathToFilename(path) {
  if (path === '/') return 'index.html.md';
  return path.slice(1).replace(/\//g, '-') + '.html.md';
}

/** 内置静态服务（SPA fallback，不依赖 npx serve） */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function startStaticServer(rootDir, port) {
  const server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = join(rootDir, urlPath);
      if (urlPath.endsWith('/')) filePath = join(filePath, 'index.html');

      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(rootDir, 'index.html');
      }
      if (!existsSync(filePath)) {
        res.writeHead(404).end('Not Found');
        return;
      }
      const type = MIME[extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(readFileSync(filePath));
    } catch {
      res.writeHead(500).end('Internal Server Error');
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(Number(port), '127.0.0.1', () => resolvePromise(server));
  });
}

/** 轮询直到服务可访问 */
async function waitForServer(url, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`静态服务未就绪: ${url}`);
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    setTimeout(resolve, 2000);
  });
}

/** 提取页面可见文本 */
async function scrapePage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);
  const title = await page.title();
  const text = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
    return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  });
  return { title, text };
}

function toMarkdown(url, { title, text }) {
  return `# ${title || url}

**URL:** ${url}

## 页面内容

${text}
`;
}

// ── 主流程 ──
mkdirSync(OUTPUT_DIR, { recursive: true });

const distAbs = resolve(__dirname, '..', DIST_DIR);
console.log(`🌐 启动本地静态服务 (dist: ${distAbs}, port: ${PREVIEW_PORT})...`);
const server = await startStaticServer(distAbs, PREVIEW_PORT);
await waitForServer(`${BASE_URL}/`);
console.log('✅ 静态服务已就绪');

let browser;
let successCount = 0;
try {
  console.log('🚀 启动无头浏览器...');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const path of paths) {
    const url = `${BASE_URL}${path === '/' ? '/' : path}`;
    const filename = pathToFilename(path);
    const outPath = resolve(OUTPUT_DIR, filename);

    console.log(`📄 抓取: ${url}`);
    try {
      const data = await scrapePage(page, url);
      writeFileSync(outPath, toMarkdown(url, data), 'utf-8');
      console.log(`   ✅ ${filename} (${data.text.length} 字符)`);
      successCount++;
    } catch (err) {
      console.warn(`   ⚠️ 跳过 ${path}: ${err.message.split('\n')[0]}`);
    }
  }

  if (successCount === 0) {
    console.error('✗ 所有页面抓取失败');
    process.exitCode = 1;
  } else {
    console.log(`\n✅ html.md 已生成 (${successCount}/${paths.length}) → ${OUTPUT_DIR}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer(server);
}
process.exit(process.exitCode || 0);
