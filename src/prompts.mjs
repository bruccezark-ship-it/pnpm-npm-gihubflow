/**
 * 交互式用户提示模块（纯 Node.js readline，零依赖）
 */
import { createInterface } from 'node:readline';

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function resolvePackageManager(input, detected, isMonorepo) {
  const allowed = isMonorepo ? ['npm', 'pnpm'] : ['npm', 'pnpm', 'yarn'];
  const normalized = input.toLowerCase();
  return allowed.includes(normalized) ? normalized : detected;
}

/**
 * 交互式询问用户配置
 * @param {import('./detect.mjs').DetectResult} detected
 */
export async function promptUser(detected) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const isMonorepo = detected.isWorkspace && detected.isSubproject;

  console.log('');
  console.log('🔍 项目检测结果:');
  console.log(`   框架:       ${detected.framework}`);
  console.log(`   打包器:     ${detected.bundler}`);
  console.log(`   语言:       ${detected.language}`);
  console.log(`   路由候选:   ${detected.routeCandidates.join(', ') || '(未找到)'}`);
  console.log(`   项目目录:   ${detected.projectDirName}`);
  console.log(`   默认域名:   ${detected.defaultDomain}`);
  if (isMonorepo) {
    console.log(`   Monorepo:   pnpm workspace`);
    console.log(`   根目录:     ${detected.workspaceRoot}`);
    console.log(`   子项目:     ${detected.subprojectPath}`);
    console.log(`   包名:       ${detected.packageName || '(未设置)'}`);
  }
  console.log(`   包管理器:   ${detected.subprojectPackageManager} @ ${detected.packageManagerVersions[detected.subprojectPackageManager]}`);
  console.log(`   Node.js:    ${detected.nodeVersion}`);
  console.log(`   Python:     ${detected.pythonVersion}`);
  console.log('');

  console.log('📝 请配置部署工作流:\n');

  // 1. 路由文件
  let routesFile;
  if (detected.routeCandidates.length === 1) {
    const def = detected.routeCandidates[0];
    const ans  = await ask(rl, `? 路由文件路径 (${def}): `);
    routesFile = ans || def;
  } else if (detected.routeCandidates.length > 1) {
    console.log('  检测到多个候选路由文件:');
    detected.routeCandidates.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    const ans = await ask(rl, `? 请选择序号或输入路径 (1): `);
    const idx = parseInt(ans, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= detected.routeCandidates.length) {
      routesFile = detected.routeCandidates[idx - 1];
    } else {
      routesFile = ans || detected.routeCandidates[0];
    }
  } else {
    const def = detected.framework === 'React' ? 'src/routes.tsx' : 'src/router/index.ts';
    const ans  = await ask(rl, `? 路由文件路径 (${def}): `);
    routesFile = ans || def;
  }

  // 2. 部署分支
  const branch = await ask(rl, '? 部署分支 (master): ') || 'master';

  // 3. 站点域名（默认 www.项目目录名.com）
  const domainInput = await ask(
    rl,
    `? 站点域名（不含协议） (${detected.defaultDomain}): `,
  );
  const domain = domainInput || detected.defaultDomain;

  // 3b. 协议选择
  const protocolInput = await ask(rl, '? 协议 http 或 https (https): ');
  const protocol = (protocolInput.toLowerCase() === 'http') ? 'http' : 'https';

  // 4. Node 版本（自动检测项目配置）
  const nodeVersion = await ask(rl, `? Node.js 版本 (${detected.nodeVersion}): `) || detected.nodeVersion;

  // 5. Python 版本（coscmd 需要，自动检测项目配置）
  const pythonVersion = await ask(rl, `? Python 版本 (${detected.pythonVersion}): `) || detected.pythonVersion;

  // 6. 包管理器（自动检测，用户输入可覆盖）
  let installCmd;
  let buildCmd;
  let installWorkingDirectory = '';
  let buildWorkingDirectory = '';
  let pnpmVersion = detected.packageManagerVersions.pnpm;
  let npmVersion = detected.packageManagerVersions.npm;
  let yarnVersion = detected.packageManagerVersions.yarn;
  let subprojectPackageManager = detected.subprojectPackageManager;

  const pmPrompt = isMonorepo
    ? `? 子项目包管理器 npm/pnpm (${detected.subprojectPackageManager}): `
    : `? 包管理器 npm/pnpm/yarn (${detected.subprojectPackageManager}): `;
  const pmInput = await ask(rl, pmPrompt);
  subprojectPackageManager = resolvePackageManager(pmInput, detected.subprojectPackageManager, isMonorepo);

  if (isMonorepo) {
    if (subprojectPackageManager === 'npm') {
      const defaultNpm = detected.packageManagerVersions.npm;
      npmVersion = await ask(rl, `? npm 版本 (${defaultNpm}): `) || defaultNpm;
      installCmd = 'npm ci';
      installWorkingDirectory = detected.subprojectPath;
      buildCmd = 'npm run build';
      buildWorkingDirectory = detected.subprojectPath;

      const installInput = await ask(rl, '? 安装命令 (npm ci): ');
      if (installInput) installCmd = installInput;
      const buildInput = await ask(rl, '? 构建命令 (npm run build): ');
      if (buildInput) buildCmd = buildInput;
    } else {
      const defaultPnpm = detected.packageManagerVersions.pnpm;
      pnpmVersion = await ask(rl, `? pnpm 版本 (${defaultPnpm}): `) || defaultPnpm;
      installCmd = 'pnpm install --frozen-lockfile';

      const filterTarget = detected.packageName
        ? detected.packageName
        : `./${detected.subprojectPath}`;
      const defaultBuild = `pnpm --filter ${filterTarget} build`;

      const buildInput = await ask(rl, `? 构建命令 (${defaultBuild}): `);
      buildCmd = buildInput || defaultBuild;

      if (buildInput && /^(npm run|npm ci|npm install|yarn|pnpm run)\b/.test(buildCmd)
          && !buildCmd.includes('--filter')) {
        buildWorkingDirectory = detected.subprojectPath;
      }
    }
  } else if (subprojectPackageManager === 'pnpm') {
    const defaultPnpm = detected.packageManagerVersions.pnpm;
    pnpmVersion = await ask(rl, `? pnpm 版本 (${defaultPnpm}): `) || defaultPnpm;
    installCmd = 'pnpm install --frozen-lockfile';
    buildCmd = await ask(rl, '? 构建命令 (pnpm run build): ') || 'pnpm run build';
  } else if (subprojectPackageManager === 'yarn') {
    const defaultYarn = detected.packageManagerVersions.yarn;
    yarnVersion = await ask(rl, `? yarn 版本 (${defaultYarn}): `) || defaultYarn;
    installCmd = 'yarn install --frozen-lockfile';
    buildCmd = await ask(rl, '? 构建命令 (yarn build): ') || 'yarn build';
  } else {
    const defaultNpm = detected.packageManagerVersions.npm;
    npmVersion = await ask(rl, `? npm 版本 (${defaultNpm}): `) || defaultNpm;
    installCmd = detected.hasPackageLock ? 'npm ci' : 'npm install';
    buildCmd = await ask(rl, '? 构建命令 (npm run build): ') || 'npm run build';
    const installInput = await ask(rl, `? 安装命令 (${installCmd}): `);
    if (installInput) installCmd = installInput;
  }

  rl.close();

  const distDir = './dist';
  const sitemapScript = 'scripts/generate-sitemap.mjs';

  return {
    routesFile,
    branch,
    domain,
    protocol,
    nodeVersion,
    pythonVersion,
    pnpmVersion,
    npmVersion,
    yarnVersion,
    installCmd,
    buildCmd,
    installWorkingDirectory,
    buildWorkingDirectory,
    framework: detected.framework,
    bundler:   detected.bundler,
    language:  detected.language,
    isMonorepo,
    subprojectPath: detected.subprojectPath || '',
    packageName: detected.packageName || '',
    subprojectPackageManager,
    hasPackageLock: detected.hasPackageLock,
    distDir,
    sitemapScript,
  };
}
