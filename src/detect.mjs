/**
 * 自动检测前端项目架构信息。
 * - 框架 (React / Vue)
 * - 打包器 (Vite / Webpack / ...)
 * - 语言 (TypeScript / JavaScript)
 * - 路由文件候选列表
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/**
 * @param {string} projectRoot - 当前 Vite 子项目目录绝对路径
 * @returns {import('./detect.mjs').DetectResult}
 */
export function detect(projectRoot) {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`未找到 package.json: ${pkgPath}\n请在 Vite 子项目目录下运行此命令`);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  const framework = detectFramework(allDeps);
  const bundler   = detectBundler(projectRoot, allDeps);
  const language  = existsSync(resolve(projectRoot, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript';
  const routeCandidates = findRouteFiles(projectRoot, framework, language);
  const workspace = detectPnpmWorkspace(projectRoot, pkg);
  const subprojectPackageManager = detectPackageManager(projectRoot);
  const hasPackageLock = existsSync(resolve(projectRoot, 'package-lock.json'));

  return {
    framework, bundler, language, routeCandidates, projectRoot,
    subprojectPackageManager, hasPackageLock,
    ...workspace,
  };
}

/**
 * 向上查找 pnpm-workspace.yaml，识别 monorepo 子项目信息
 */
function detectPnpmWorkspace(projectRoot, pkg) {
  const workspaceRoot = findWorkspaceRoot(projectRoot) || projectRoot;

  const hasWorkspaceFile = existsSync(resolve(workspaceRoot, 'pnpm-workspace.yaml'))
                        || existsSync(resolve(workspaceRoot, 'pnpm-workspace.yml'));
  const hasPnpmLock = existsSync(resolve(workspaceRoot, 'pnpm-lock.yaml'));
  const isWorkspace = hasWorkspaceFile || hasPnpmLock;

  const subprojectPath = relative(workspaceRoot, projectRoot).replace(/\\/g, '/');
  const isSubproject = subprojectPath !== '' && subprojectPath !== '.';

  return {
    isWorkspace,
    isSubproject,
    workspaceRoot,
    subprojectPath: isSubproject ? subprojectPath : '',
    packageName: pkg.name || '',
  };
}

function findWorkspaceRoot(startDir) {
  let dir = resolve(startDir);
  let pnpmLockRoot = null;

  while (true) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))
        || existsSync(resolve(dir, 'pnpm-workspace.yml'))) {
      return dir;
    }
    if (existsSync(resolve(dir, 'pnpm-lock.yaml'))) {
      pnpmLockRoot = dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // 子项目目录向上找到了 pnpm-lock.yaml，视为 workspace 安装根目录
  if (pnpmLockRoot && pnpmLockRoot !== resolve(startDir)) {
    return pnpmLockRoot;
  }
  return pnpmLockRoot;
}

/**
 * 根据子项目目录下的 lockfile / packageManager 字段识别包管理器
 */
function detectPackageManager(projectDir) {
  if (existsSync(resolve(projectDir, 'package-lock.json'))) return 'npm';
  if (existsSync(resolve(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(projectDir, 'yarn.lock'))) return 'yarn';

  const pkgPath = resolve(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const pm = pkg.packageManager || '';
      if (pm.startsWith('npm')) return 'npm';
      if (pm.startsWith('pnpm')) return 'pnpm';
      if (pm.startsWith('yarn')) return 'yarn';
    } catch { /* ignore */ }
  }

  return 'pnpm';
}

function detectFramework(deps) {
  if (deps.react || deps['react-dom']) return 'React';
  if (deps.vue)                          return 'Vue';
  return 'Unknown';
}

function detectBundler(root, deps) {
  const hasViteConfig = existsSync(resolve(root, 'vite.config.ts'))
                     || existsSync(resolve(root, 'vite.config.js'))
                     || existsSync(resolve(root, 'vite.config.mjs'));
  if (deps.vite || hasViteConfig) return 'Vite';
  if (deps.webpack || deps['@vue/cli-service']) return 'Webpack';
  return 'Unknown';
}

/**
 * 扫描候选路由文件
 */
function findRouteFiles(root, framework, language) {
  const ext  = language === 'TypeScript' ? 'ts' : 'js';
  const extx = language === 'TypeScript' ? 'tsx' : 'jsx';
  const candidates = [];

  const addIfExists = (rel) => {
    if (existsSync(resolve(root, rel))) candidates.push(rel);
  };

  if (framework === 'React') {
    for (const e of [extx, ext]) {
      addIfExists(`src/routes.${e}`);
      addIfExists(`src/router.${e}`);
      addIfExists(`src/router/index.${e}`);
      addIfExists(`src/router/routes.${e}`);
      addIfExists(`src/config/routes.${e}`);
    }
    // 深度扫描 src/ 中含路由关键字的文件
    for (const f of scanRouteFiles(root, extx)) {
      if (!candidates.includes(f)) candidates.push(f);
    }
  }

  if (framework === 'Vue') {
    addIfExists(`src/router/index.${ext}`);
    addIfExists(`src/router.${ext}`);
    addIfExists(`src/routes.${ext}`);
    for (const f of scanRouteFiles(root, ext)) {
      if (!candidates.includes(f)) candidates.push(f);
    }
  }

  if (candidates.length === 0) {
    candidates.push(framework === 'React' ? `src/routes.${extx}` : `src/router/index.${ext}`);
  }

  return candidates;
}

/**
 * 递归扫描 src/ 目录，寻找含路由定义的文件
 */
function scanRouteFiles(root, ext) {
  const srcDir = resolve(root, 'src');
  if (!existsSync(srcDir)) return [];

  const found = [];

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!entry.startsWith('.') && entry !== 'node_modules') walk(full);
      } else if (st.isFile() && entry.endsWith(`.${ext}`)) {
        try {
          const content = readFileSync(full, 'utf-8');
          // 匹配 react-router / vue-router 常见模式
          if (/\b(createBrowserRouter|createRouter|Routes|Route\b.*\bpath\s*:|routes\s*:\s*\[)/.test(content)) {
            found.push(relative(root, full).replace(/\\/g, '/'));
          }
        } catch { /* 忽略权限/编码错误 */ }
      }
    }
  }

  walk(srcDir);
  return found;
}

