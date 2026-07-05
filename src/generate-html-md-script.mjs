/**
 * 生成 scripts/generate-html-md.mjs 脚本内容。
 * 使用 Playwright 无头浏览器抓取一级页面文本，输出 Markdown 供大模型读取。
 *
 * @param {object} cfg
 * @param {string} cfg.routesFile
 * @param {string} cfg.framework
 */
export function generateHtmlMdScript(cfg) {
  const { routesFile, framework } = cfg;
  const isVue = framework === 'Vue';

  const extractionLogic = isVue
    ? `const routeArrayRegex = /routes\\s*:\\s*\\[([\\s\\S]*?)\\](?=\\s*[,\\)])/;
let arrayMatch = routeArrayRegex.exec(content);
if (!arrayMatch) {
  arrayMatch = /export\\s+const\\s+routes[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\];/.exec(content);
}`
    : `const routeArrayRegex = /export\\s+const\\s+routes[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\];/;
let arrayMatch = routeArrayRegex.exec(content);
if (!arrayMatch) {
  arrayMatch = /createBrowserRouter\\s*\\(\\s*\\[([\\s\\S]*?)\\](?=\\s*[,\\)])/.exec(content);
}`;

  return `/**
 * 抓取一级页面文本，生成 Markdown 文档（供大模型读取）。
 *
 * 仅抓取一级路由（/ 或单段路径，如 /contacts）。
 * 文件名规则: / → index.md，/contacts → contacts.md
 *
 * 用法: node scripts/generate-html-md.mjs
 * 环境变量:
 *   BASE_URL    - 本地预览地址，默认 http://127.0.0.1:4173
 *   OUTPUT_DIR  - 输出目录，默认 ./dist（与静态站点同目录）
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
const routesPath  = resolve(__dirname, '..', '${routesFile.replace(/\\\\/g, '/')}');
const BASE_URL    = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\\/+$/, '');
const OUTPUT_DIR  = process.env.OUTPUT_DIR || './dist';
const DIST_DIR    = process.env.DIST_DIR || './dist';
const PREVIEW_PORT = new URL(BASE_URL).port || '4173';

// ── 解析路由 ──
const content = readFileSync(routesPath, 'utf-8');
${extractionLogic}

if (!arrayMatch) {
  console.error('✗ 未能找到路由定义数组');
  process.exit(1);
}

const pathRegex = /path\\s*:\\s*['"\`]([^'"\`]+)['"\`]/g;
const allPaths = [];
let match;
while ((match = pathRegex.exec(arrayMatch[1])) !== null) {
  let p = match[1];
  if (p === '*' || p === '/*' || p.includes(':') || !p.startsWith('/')) continue;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  allPaths.push(p);
}

/** 一级页面: / 或 /segment（不含子路径） */
function isFirstLevel(path) {
  if (path === '/') return true;
  const segs = path.split('/').filter(Boolean);
  return segs.length === 1;
}

/** 去重、仅保留一级页面并排序（/ 优先） */
const paths = [...new Set(allPaths)].filter(isFirstLevel).sort((a, b) => {
  if (a === '/') return -1;
  if (b === '/') return 1;
  return a.localeCompare(b);
});

if (paths.length === 0) {
  console.error('✗ 未找到一级页面路由');
  process.exit(1);
}

console.log(\`📋 一级页面 (\${paths.length}): \${paths.join(', ')}\`);

/** 路由 → Markdown 相对路径（/ → index.md，/contacts → contacts.md） */
function pathToFilename(path) {
  if (path === '/') return 'index.md';
  return path.slice(1) + '.md';
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
  throw new Error(\`静态服务未就绪: \${url}\`);
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    setTimeout(resolve, 2000);
  });
}

/** 提取页面可见文本（DOM → 结构化 Markdown） */
async function scrapePage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);
  const title = await page.title();
  const text = await page.evaluate(() => {
    const SKIP_TAGS = new Set([
      'script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'video', 'audio',
    ]);
    const CHROME_TAGS = new Set(['nav', 'footer']);
    const HEADING = {
      h1: '#', h2: '##', h3: '###', h4: '####', h5: '#####', h6: '######',
    };
    const BLOCK_CONTAINERS = new Set([
      'div', 'section', 'article', 'main', 'header', 'aside', 'li', 'td', 'th',
    ]);

    function clean(text) {
      return text.replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').trim();
    }

    function isHidden(el) {
      if (!(el instanceof Element)) return false;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    }

    function hasBlockChild(el) {
      return [...el.children].some((child) => {
        const tag = child.tagName.toLowerCase();
        return HEADING[tag] || tag === 'p' || tag === 'ul' || tag === 'ol'
          || tag === 'blockquote' || tag === 'pre' || tag === 'table' || tag === 'hr'
          || (BLOCK_CONTAINERS.has(tag) && hasBlockChild(child));
      });
    }

    function collectInline(el) {
      let out = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          out += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName.toLowerCase();
          if (SKIP_TAGS.has(tag) || CHROME_TAGS.has(tag) || isHidden(node)) continue;
          if (tag === 'br') { out += '\\n'; continue; }
          if (tag === 'strong' || tag === 'b') {
            out += '**' + collectInline(node) + '**';
            continue;
          }
          if (tag === 'em' || tag === 'i') {
            out += '*' + collectInline(node) + '*';
            continue;
          }
          if (tag === 'code') {
            out += '\`' + clean(collectInline(node)) + '\`';
            continue;
          }
          if (tag === 'a') {
            const label = clean(collectInline(node));
            const href = node.getAttribute('href') || '';
            out += href && href !== '#' ? '[' + label + '](' + href + ')' : label;
            continue;
          }
          out += collectInline(node);
        }
      }
      return out;
    }

    function paragraph(text) {
      const t = clean(text);
      return t ? t + '\\n\\n' : '';
    }

    function renderList(el, ordered) {
      const items = [...el.children].filter((c) => c.tagName.toLowerCase() === 'li');
      let md = '';
      items.forEach((li, i) => {
        const prefix = ordered ? (i + 1) + '. ' : '- ';
        const parts = [];
        for (const child of li.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const t = clean(child.textContent);
            if (t) parts.push(t);
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.tagName.toLowerCase();
            if (tag === 'ul' || tag === 'ol') {
              parts.push(renderList(child, tag === 'ol').trimEnd());
            } else if (tag === 'p') {
              parts.push(clean(collectInline(child)));
            } else {
              parts.push(collectBlocks(child).trim());
            }
          }
        }
        const content = clean(parts.join(' '));
        if (content) md += prefix + content + '\\n';
      });
      return md ? md + '\\n' : '';
    }

    function renderTable(el) {
      const rows = [...el.querySelectorAll('tr')];
      if (!rows.length) return '';
      const tableRows = rows.map((row) =>
        [...row.querySelectorAll('th, td')].map((cell) => clean(collectInline(cell)).replace(/\\|/g, '\\\\|')),
      );
      const widths = tableRows[0]?.map((_, i) =>
        Math.max(...tableRows.map((r) => (r[i] || '').length), 3),
      ) || [];
      const formatRow = (cells) =>
        '| ' + cells.map((c, i) => (c || '').padEnd(widths[i])).join(' | ') + ' |\\n';
      let md = formatRow(tableRows[0]);
      md += '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |\\n';
      for (let i = 1; i < tableRows.length; i++) md += formatRow(tableRows[i]);
      return md + '\\n';
    }

    function renderBlock(el) {
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag) || CHROME_TAGS.has(tag) || isHidden(el)) return '';

      if (HEADING[tag]) return paragraph(HEADING[tag] + ' ' + collectInline(el));
      if (tag === 'p') return paragraph(collectInline(el));
      if (tag === 'hr') return '---\\n\\n';
      if (tag === 'blockquote') {
        const inner = clean(collectBlocks(el));
        return inner ? inner.split('\\n').map((line) => '> ' + line).join('\\n') + '\\n\\n' : '';
      }
      if (tag === 'ul') return renderList(el, false);
      if (tag === 'ol') return renderList(el, true);
      if (tag === 'pre') {
        const codeEl = el.querySelector('code');
        const raw = (codeEl ? codeEl.textContent : el.textContent).trim();
        return raw ? '\`\`\`\\n' + raw + '\\n\`\`\`\\n\\n' : '';
      }
      if (tag === 'table') return renderTable(el);

      if (BLOCK_CONTAINERS.has(tag) && !hasBlockChild(el)) {
        return paragraph(collectInline(el));
      }

      return collectBlocks(el);
    }

    function collectBlocks(parent) {
      let md = '';
      for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          md += paragraph(node.textContent);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          md += renderBlock(node);
        }
      }
      return md;
    }

    const root = document.querySelector('main')
      || document.querySelector('[role="main"]')
      || document.body;

    return collectBlocks(root).replace(/\\n{3,}/g, '\\n\\n').trim();
  });
  return { title, text };
}

function toMarkdown(url, { title, text }) {
  const heading = title || url;
  const safeTitle = heading.replace(/"/g, '\\\\"');
  const body = text.trim();
  return \`---
title: "\${safeTitle}"
url: "\${url}"
---

\${body}
\`;
}

// ── 主流程 ──
mkdirSync(OUTPUT_DIR, { recursive: true });

const distAbs = resolve(__dirname, '..', DIST_DIR);
console.log(\`🌐 启动本地静态服务 (dist: \${distAbs}, port: \${PREVIEW_PORT})...\`);
const server = await startStaticServer(distAbs, PREVIEW_PORT);
await waitForServer(\`\${BASE_URL}/\`);
console.log('✅ 静态服务已就绪');

let browser;
let successCount = 0;
try {
  console.log('🚀 启动无头浏览器...');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const path of paths) {
    const url = \`\${BASE_URL}\${path === '/' ? '/' : path}\`;
    const filename = pathToFilename(path);
    const outPath = resolve(OUTPUT_DIR, filename);
    mkdirSync(dirname(outPath), { recursive: true });

    console.log(\`📄 抓取: \${url}\`);
    try {
      const data = await scrapePage(page, url);
      writeFileSync(outPath, toMarkdown(url, data), 'utf-8');
      console.log(\`   ✅ \${filename} (\${data.text.length} 字符)\`);
      successCount++;
    } catch (err) {
      console.warn(\`   ⚠️ 跳过 \${path}: \${err.message.split('\\n')[0]}\`);
    }
  }

  if (successCount === 0) {
    console.error('✗ 所有页面抓取失败');
    process.exitCode = 1;
  } else {
    console.log(\`\\n✅ Markdown 已生成 (\${successCount}/\${paths.length}) → \${OUTPUT_DIR}\`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer(server);
}
process.exit(process.exitCode || 0);
`;
}
