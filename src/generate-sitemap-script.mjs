/**
 * 生成 scripts/generate-sitemap.mjs 脚本内容。
 * 路由文件路径由用户指定，写入脚本中。
 *
 * @param {object} cfg
 * @param {string} cfg.routesFile  - 路由文件相对项目根的路径，如 "src/routes.tsx"
 * @param {string} cfg.framework   - React / Vue
 * @param {string} cfg.language    - TypeScript / JavaScript
 */
export function generateSitemapScript(cfg) {
  const { routesFile, framework, language } = cfg;

  // 根据框架和语言调整正则模式
  // React: TSX/JSX 文件 export const routes = [...]
  // Vue: router/index.ts 中 routes: [...]
  const isVue = framework === 'Vue';

  // 通用解析策略：同时支持两种模式
  const extractionLogic = isVue
    ? `// Vue Router 写法: routes: [{ path: '/', ... }, ...]
const routeArrayRegex = /routes\\s*:\\s*\\[([\\s\\S]*?)\\](?=\\s*[,\\)])/;
let arrayMatch = routeArrayRegex.exec(content);
// 兜底: export const routes = [...]
if (!arrayMatch) {
  arrayMatch = /export\\s+const\\s+routes[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\];/.exec(content);
}`
    : `// React Router 写法: export const routes = [{ path: '/', ... }, ...]
const routeArrayRegex = /export\\s+const\\s+routes[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\];/;
let arrayMatch = routeArrayRegex.exec(content);
// 兜底: createBrowserRouter([...])
if (!arrayMatch) {
  arrayMatch = /createBrowserRouter\\s*\\(\\s*\\[([\\s\\S]*?)\\](?=\\s*[,\\)])/.exec(content);
}`;

  return `/**
 * 从 ${routesFile} 中解析所有路由路径，自动生成 sitemap.xml 和 robots.txt。
 *
 * 用法:  node scripts/generate-sitemap.mjs
 * 环境变量:
 *   FULL_URL   - 网站完整 URL，如 https://www.example.com
 *   OUTPUT_DIR - 输出目录，默认 ./dist
 *
 * ⚠️ 此文件由 gitflow 工具自动生成。
 *    如需修改 SEO 配置，请编辑下方 SEO_CONFIG 对象。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
//  SEO 配置 — 按路由路径设置 priority 与 changefreq
//  未配置的路由默认 priority=0.8 / changefreq=monthly
// ============================================================
const SEO_CONFIG = {
  '/':          { priority: '1.0', changefreq: 'daily'   },
  '/products':  { priority: '0.9', changefreq: 'weekly'  },
  '/solutions': { priority: '0.9', changefreq: 'weekly'  },
  '/projects':  { priority: '0.8', changefreq: 'weekly'  },
  '/knowledge': { priority: '0.8', changefreq: 'weekly'  },
};

const DEFAULT_PRIORITY   = '0.8';
const DEFAULT_CHANGEFREQ = 'monthly';

// ============================================================
//  解析路由文件
// ============================================================
const __dirname  = dirname(fileURLToPath(import.meta.url));
const routesPath = resolve(__dirname, '..', '${routesFile.replace(/\\\\/g, '/')}');
const content    = readFileSync(routesPath, 'utf-8');

${extractionLogic}

if (!arrayMatch) {
  console.error('✗ 未能找到路由定义数组（支持 export const routes / createBrowserRouter / routes: [...]');
  process.exit(1);
}

// 从每个路由对象中提取 path 字段值
const pathRegex = /path\\s*:\\s*['"\`]([^'"\`]+)['"\`]/g;
const paths = [];
let match;
while ((match = pathRegex.exec(arrayMatch[1])) !== null) {
  // 排除通配路由（如 '*' 或 '404'）
  const p = match[1];
  if (p === '*' || p === '/*' || p.includes(':')) continue;
  paths.push(p);
}

if (paths.length === 0) {
  console.error('✗ 未能解析到任何路由路径');
  process.exit(1);
}

console.log(\`📋 从 ${routesFile} 解析到 \${paths.length} 个路由: \${paths.join(', ')}\`);

// ============================================================
//  生成 sitemap.xml
// ============================================================
const FULL_URL   = (process.env.FULL_URL   || 'http://localhost').replace(/\\/+$/, '');
const OUTPUT_DIR = process.env.OUTPUT_DIR || './dist';

mkdirSync(OUTPUT_DIR, { recursive: true });

const today = new Date().toISOString().split('T')[0];

const urlEntries = paths.map((path) => {
  const cfg = SEO_CONFIG[path] || { priority: DEFAULT_PRIORITY, changefreq: DEFAULT_CHANGEFREQ };
  return \`  <url>
    <loc>\${FULL_URL}\${path}</loc>
    <lastmod>\${today}</lastmod>
    <changefreq>\${cfg.changefreq}</changefreq>
    <priority>\${cfg.priority}</priority>
  </url>\`;
});

const sitemap = \`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
\${urlEntries.join('\\n')}
</urlset>
\`;

const sitemapPath = resolve(OUTPUT_DIR, 'sitemap.xml');
writeFileSync(sitemapPath, sitemap, 'utf-8');
console.log(\`✅ sitemap.xml 已生成 (\${paths.length} 个 URL) → \${sitemapPath}\`);

// ============================================================
//  生成 robots.txt
// ============================================================
const robotsTxt = \`User-agent: *
Allow: /
Sitemap: \${FULL_URL}/sitemap.xml
\`;

const robotsPath = resolve(OUTPUT_DIR, 'robots.txt');
writeFileSync(robotsPath, robotsTxt, 'utf-8');
console.log(\`✅ robots.txt  已生成 → \${robotsPath}\`);
`;
}
