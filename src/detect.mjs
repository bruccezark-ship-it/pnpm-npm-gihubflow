/**
 * 自动检测前端项目架构信息。
 * - 框架 (React / Vue)
 * - 打包器 (Vite / Webpack / ...)
 * - 语言 (TypeScript / JavaScript)
 * - 路由文件候选列表
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';

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
  const nodeVersion = detectNodeVersion(projectRoot, workspace.workspaceRoot, pkg);
  const pythonVersion = detectPythonVersion(projectRoot, workspace.workspaceRoot);
  const projectDirName = basename(projectRoot);
  const defaultDomain = `www.${projectDirName}.com`;
  const packageManagerVersions = detectPackageManagerVersions(
    projectRoot, workspace.workspaceRoot, pkg,
  );

  return {
    framework, bundler, language, routeCandidates, projectRoot,
    subprojectPackageManager, hasPackageLock,
    nodeVersion, pythonVersion, projectDirName, defaultDomain,
    packageManagerVersions,
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

/** 解析 packageManager 字段，如 "pnpm@10.33.4" */
function parsePackageManagerField(field) {
  if (!field || typeof field !== 'string') return null;
  const m = field.trim().match(/^(pnpm|npm|yarn)@(.+)$/);
  return m ? { name: m[1], version: m[2] } : null;
}

/** 从 pnpm-lock.yaml 的 lockfileVersion 推断 pnpm 主版本 */
function detectPnpmVersionFromLockfile(lockPath) {
  const content = readTextFile(lockPath);
  if (!content) return null;
  const m = content.match(/^lockfileVersion:\s*['"]?(\d+(?:\.\d+)?)/m);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  if (major >= 9) return '9';
  if (major >= 6) return '8';
  return '7';
}

/** 从 package-lock.json 推断 npm 版本 */
function detectNpmVersionFromLockfile(lockPath) {
  const content = readTextFile(lockPath);
  if (!content) return null;
  try {
    const lock = JSON.parse(content);
    if (lock.npm && typeof lock.npm === 'string') {
      return lock.npm.replace(/^npm@/, '');
    }
    const lv = lock.lockfileVersion;
    if (typeof lv === 'number') {
      if (lv >= 3) return '10';
      if (lv === 2) return '8';
      return '6';
    }
  } catch { /* ignore */ }
  return null;
}

/** 从已有 workflow 读取 pnpm / npm / yarn 版本 */
function detectPmVersionFromWorkflows(root, pm) {
  const wfDir = resolve(root, '.github', 'workflows');
  if (!existsSync(wfDir)) return null;

  const patterns = {
    pnpm: /pnpm\/action-setup@v[\d.]+\s*\n\s*with:\s*\n\s*version:\s*['"]?([^\s'"]+)/,
    npm: /npm install -g npm@([^\s'"]+)|corepack prepare npm@([^\s'"]+)/,
    yarn: /corepack prepare yarn@([^\s'"]+)/,
  };
  const pattern = patterns[pm];
  if (!pattern) return null;

  try {
    for (const f of readdirSync(wfDir)) {
      if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
      const content = readFileSync(resolve(wfDir, f), 'utf-8');
      const m = content.match(pattern);
      if (m) return m[1] || m[2] || null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 检测各包管理器版本
 * 优先级: packageManager 字段 → volta → lockfile → 已有 workflow → 默认值
 */
function detectPackageManagerVersions(projectRoot, workspaceRoot, pkg) {
  const defaults = { pnpm: '9', npm: '10', yarn: '4' };
  const result = { ...defaults };

  for (const pm of ['pnpm', 'npm', 'yarn']) {
    result[pm] = detectSinglePackageManagerVersion(
      projectRoot, workspaceRoot, pkg, pm, defaults[pm],
    );
  }
  return result;
}

function detectSinglePackageManagerVersion(projectRoot, workspaceRoot, pkg, pm, fallback) {
  const dirs = [projectRoot];
  if (workspaceRoot && workspaceRoot !== projectRoot) dirs.push(workspaceRoot);

  for (const dir of dirs) {
    const dirPkg = dir === projectRoot ? pkg : readPkgJson(dir);

    const fromField = parsePackageManagerField(dirPkg?.packageManager);
    if (fromField?.name === pm) return fromField.version;

    if (dirPkg?.volta?.[pm]) return dirPkg.volta[pm];
  }

  if (pm === 'pnpm') {
    for (const dir of dirs) {
      const v = detectPnpmVersionFromLockfile(resolve(dir, 'pnpm-lock.yaml'));
      if (v) return v;
    }
  }

  if (pm === 'npm') {
    for (const dir of dirs) {
      const v = detectNpmVersionFromLockfile(resolve(dir, 'package-lock.json'));
      if (v) return v;
    }
  }

  for (const dir of dirs) {
    const fromWf = detectPmVersionFromWorkflows(dir, pm);
    if (fromWf) return fromWf;
  }

  return fallback;
}

function readTextFile(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf-8').trim(); } catch { return null; }
}

/** 从版本字符串提取 Node 主版本号，如 "20.11.0" → "20" */
function normalizeNodeVersion(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/^v/i, '').trim();
  if (/^lts/i.test(cleaned) || cleaned === 'node') return null;
  const m = cleaned.match(/(\d+)/);
  return m ? m[1] : null;
}

/** 从版本字符串提取 Python 版本，如 "3.11.5" → "3.11" */
function normalizePythonVersion(raw) {
  if (!raw) return null;
  const m = raw.trim().match(/(\d+\.\d+)/);
  return m ? m[1] : null;
}

/** 从已有 workflow 文件中读取 node-version / python-version */
function detectFromWorkflows(root, field) {
  const wfDir = resolve(root, '.github', 'workflows');
  if (!existsSync(wfDir)) return null;

  const pattern = field === 'node'
    ? /node-version:\s*['"]?(\d+)/
    : /python-version:\s*['"]?(\d+\.\d+)/;

  try {
    for (const f of readdirSync(wfDir)) {
      if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
      const content = readFileSync(resolve(wfDir, f), 'utf-8');
      const m = content.match(pattern);
      if (m) return m[1];
    }
  } catch { /* ignore */ }
  return null;
}

function readPkgJson(dir) {
  const p = resolve(dir, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * 检测 Node.js 版本
 * 优先级: .nvmrc / .node-version → volta.node → engines.node → 已有 workflow → 默认 24
 */
function detectNodeVersion(projectRoot, workspaceRoot, pkg) {
  const dirs = [projectRoot];
  if (workspaceRoot && workspaceRoot !== projectRoot) dirs.push(workspaceRoot);

  for (const dir of dirs) {
    for (const file of ['.nvmrc', '.node-version']) {
      const v = normalizeNodeVersion(readTextFile(resolve(dir, file)));
      if (v) return v;
    }

    const dirPkg = dir === projectRoot ? pkg : readPkgJson(dir);
    if (dirPkg?.volta?.node) {
      const v = normalizeNodeVersion(dirPkg.volta.node);
      if (v) return v;
    }
    if (dirPkg?.engines?.node) {
      const v = normalizeNodeVersion(dirPkg.engines.node);
      if (v) return v;
    }

    const fromWf = detectFromWorkflows(dir, 'node');
    if (fromWf) return fromWf;
  }

  return '24';
}

/**
 * 检测 Python 版本（coscmd 用）
 * 优先级: .python-version → runtime.txt → .tool-versions → 已有 workflow → 默认 3.11
 */
function detectPythonVersion(projectRoot, workspaceRoot) {
  const dirs = [projectRoot];
  if (workspaceRoot && workspaceRoot !== projectRoot) dirs.push(workspaceRoot);

  for (const dir of dirs) {
    const pyVersion = readTextFile(resolve(dir, '.python-version'));
    if (pyVersion) {
      const v = normalizePythonVersion(pyVersion);
      if (v) return v;
    }

    const runtime = readTextFile(resolve(dir, 'runtime.txt'));
    if (runtime) {
      const v = normalizePythonVersion(runtime.replace(/^python-?/i, ''));
      if (v) return v;
    }

    const toolVersions = readTextFile(resolve(dir, '.tool-versions'));
    if (toolVersions) {
      const m = toolVersions.match(/^python\s+(\S+)/m);
      if (m) {
        const v = normalizePythonVersion(m[1]);
        if (v) return v;
      }
    }

    const fromWf = detectFromWorkflows(dir, 'python');
    if (fromWf) return fromWf;
  }

  return '3.11';
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

