#!/usr/bin/env node

/**
 * gitflow
 *
 * 全局 CLI 工具：自动检测 Vite React/Vue TypeScript 前端项目，
 * 交互式生成 GitHub Actions 部署工作流 + sitemap 生成脚本。
 *
 * 用法:
 *   npm install -g gitflow
 *   cd my-vite-project
 *   gitflow
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detect } from '../src/detect.mjs';
import { promptUser } from '../src/prompts.mjs';
import { generateWorkflowYaml } from '../src/generate-workflow.mjs';
import { generateSitemapScript } from '../src/generate-sitemap-script.mjs';
import { generateHtmlMdScript } from '../src/generate-html-md-script.mjs';

const cwd = process.cwd();

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   🚀 gitflow  v1.0.0                    ║');
console.log('║   前端项目 CI/CD 工作流生成器            ║');
console.log('╚══════════════════════════════════════════╝');

// ──────────── 1. 检测项目 ────────────
let detected;
try {
  detected = detect(cwd);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}

if (detected.framework === 'Unknown') {
  console.warn('⚠️  未能自动识别框架，将按通用 Vite 项目处理');
  detected.framework = 'General';
}

if (detected.isWorkspace && !detected.isSubproject) {
  console.warn('⚠️  当前位于 pnpm workspace 根目录，请在 Vite 子项目目录下运行');
  console.warn('    例如: cd apps/web && gitflow');
}

// ──────────── 2. 交互询问 ────────────
const cfg = await promptUser(detected);

// ──────────── 3. 生成文件（均写入当前 Vite 子项目根目录）────────────
const workflowsDir = resolve(cwd, '.github', 'workflows');
const scriptsDir   = resolve(cwd, 'scripts');

mkdirSync(workflowsDir, { recursive: true });
mkdirSync(scriptsDir,   { recursive: true });

// 3a. 工作流 YAML
const workflowPath = resolve(workflowsDir, 'deploy-cos.yml');
const workflowYaml = generateWorkflowYaml(cfg);
writeFileSync(workflowPath, workflowYaml, 'utf-8');

// 3b. Sitemap 生成脚本
const sitemapScriptPath = resolve(scriptsDir, 'generate-sitemap.mjs');
const sitemapScript     = generateSitemapScript(cfg);
writeFileSync(sitemapScriptPath, sitemapScript, 'utf-8');

// 3c. 一级页面 Markdown 抓取脚本
const htmlMdScriptPath = resolve(scriptsDir, 'generate-html-md.mjs');
const htmlMdScript     = generateHtmlMdScript(cfg);
writeFileSync(htmlMdScriptPath, htmlMdScript, 'utf-8');

// ──────────── 4. 输出结果 ────────────
console.log('');
console.log('✅ 文件生成完毕:');
console.log(`   📄 .github/workflows/deploy-cos.yml`);
console.log(`   📄 scripts/generate-sitemap.mjs`);
console.log(`   📄 scripts/generate-html-md.mjs`);
console.log('');
console.log('📋 接下来需要在 GitHub 仓库设置以下 Secrets:');
console.log('');
console.log('   Secret           说明');
console.log('   ───────────────  ──────────────────────────');
if (cfg.domain) {
  console.log(`   SITE_URL          （可选）CI 回退域名；当前 gitflow 已配置: ${cfg.protocol}://${cfg.domain}`);
} else {
  console.log('   SITE_URL          （可选）站点域名，未配置时使用 www.仓库名.com');
}
console.log('   COS_SECRET_ID     腾讯云 SecretId');
console.log('   COS_SECRET_KEY    腾讯云 SecretKey');
console.log('   COS_BUCKET        腾讯云 COS 存储桶名称');
console.log('   COS_REGION        COS 地域（如 ap-guangzhou）');
console.log('   COS_TARGET_PATH   上传目标路径（可选，默认 /Default）');
console.log('');
console.log(`🚀 推送至 ${cfg.branch} 分支即可自动触发部署！`);
console.log('');
