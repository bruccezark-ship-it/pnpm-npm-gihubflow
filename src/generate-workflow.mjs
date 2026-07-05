/**
 * 生成 workflow 中解析站点 URL 的 shell 片段
 * 优先级: 1. gitflow 用户输入  2. SITE_URL secret  3. www.仓库名.com
 */
function buildSiteUrlShell(cfg, { exportEnv = false } = {}) {
  const userDomain = (cfg.domain || '').replace(/"/g, '\\"');
  const protocol = cfg.protocol || 'https';
  const envExport = exportEnv
    ? '\n          echo "SITE_DISPLAY_URL=${FULL_URL}" >> "$GITHUB_ENV"'
    : '';

  return `
          # 域名优先级: 1. gitflow 用户输入  2. SITE_URL secret  3. www.仓库名.com
          USER_DOMAIN="${userDomain}"
          PROTOCOL="${protocol}"

          if [ -n "$USER_DOMAIN" ]; then
            if [[ "$USER_DOMAIN" =~ ^https?:// ]]; then
              FULL_URL="$USER_DOMAIN"
            else
              FULL_URL="\${PROTOCOL}://\${USER_DOMAIN}"
            fi
            echo "🌐 Using user-configured site URL: \${FULL_URL}"
          elif [ -n "\${SITE_URL}" ]; then
            if [[ "\${SITE_URL}" =~ ^https?:// ]]; then
              FULL_URL="\${SITE_URL}"
            else
              FULL_URL="\${PROTOCOL}://\${SITE_URL}"
            fi
            echo "🌐 Using SITE_URL secret: \${FULL_URL}"
          else
            REPO_NAME="\${{ github.event.repository.name }}"
            FULL_URL="\${PROTOCOL}://www.\${REPO_NAME}.com"
            echo "🌐 Using repository name fallback: \${FULL_URL}"
          fi${envExport}`;
}

/**
 * 生成 .github/workflows/deploy-cos.yml 内容
 * @param {object} cfg - 用户配置 (来自 prompts)
 */
export function generateWorkflowYaml(cfg) {
  const sitemapScript = cfg.sitemapScript || 'scripts/generate-sitemap.mjs';
  const htmlMdScript = cfg.htmlMdScript || 'scripts/generate-html-md.mjs';
  const distDir = cfg.distDir || './dist';
  const needsPnpm = cfg.subprojectPackageManager === 'pnpm'
    || cfg.installCmd.startsWith('pnpm')
    || cfg.buildCmd.startsWith('pnpm');
  const needsNpm = cfg.subprojectPackageManager === 'npm'
    || cfg.installCmd.startsWith('npm');

  const needsYarn = cfg.subprojectPackageManager === 'yarn'
    || cfg.installCmd.startsWith('yarn')
    || cfg.buildCmd.startsWith('yarn');

  // monorepo 子项目路径；CI 仓库可能是完整 monorepo，也可能仅包含子项目本身
  const hasSubprojectPath = Boolean(cfg.subprojectPath);

  const resolveStep = hasSubprojectPath ? `
      - name: Resolve project directory
        id: project
        run: |
          SUB="${cfg.subprojectPath}"
          if [ -n "$SUB" ] && [ -d "$SUB" ] && [ -f "$SUB/package.json" ]; then
            echo "dir=$SUB" >> $GITHUB_OUTPUT
            echo "dist=$SUB/dist" >> $GITHUB_OUTPUT
            echo "lockfile=$SUB/package-lock.json" >> $GITHUB_OUTPUT
            echo "Using monorepo subproject: $SUB"
          elif [ -f "package.json" ]; then
            echo "dir=." >> $GITHUB_OUTPUT
            echo "dist=dist" >> $GITHUB_OUTPUT
            echo "lockfile=package-lock.json" >> $GITHUB_OUTPUT
            echo "Using repository root as project directory"
          else
            echo "::error::Cannot find Vite project (tried: \${SUB:-repo root})"
            exit 1
          fi
` : '';

  const projectWd = hasSubprojectPath
    ? `\n        working-directory: \${{ steps.project.outputs.dir }}`
    : '';
  const uploadDist = hasSubprojectPath
    ? '${{ steps.project.outputs.dist }}'
    : distDir.replace(/^\.\//, '');

  const debugSub = hasSubprojectPath ? `
          echo "=== Resolved project dir: \${{ steps.project.outputs.dir }} ==="
          ls -la \${{ steps.project.outputs.dir }}/ 2>/dev/null || ls -la` : '';

  const pnpmSetupSteps = needsPnpm ? `
      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: '${cfg.pnpmVersion || '9'}'
` : '';

  const yarnSetupSteps = needsYarn ? `
      - name: Setup Yarn
        run: |
          corepack enable
          corepack prepare yarn@${cfg.yarnVersion || '4'} --activate
` : '';

  const npmSetupSteps = needsNpm ? `
      - name: Setup npm
        run: npm install -g npm@${cfg.npmVersion || '10'}
` : '';

  const npmCachePath = hasSubprojectPath
    ? '${{ steps.project.outputs.lockfile }}'
    : 'package-lock.json';

  // npm：解析目录 → 装 Node → 生成 lockfile → 带 cache 的 setup-node
  const nodeSetupSteps = needsNpm ? `
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '${cfg.nodeVersion}'

      - name: Ensure package-lock.json${projectWd}
        run: |
          if [ ! -f package-lock.json ]; then
            echo "📦 Generating package-lock.json from package.json..."
            npm install --package-lock-only --ignore-scripts
          else
            echo "✅ package-lock.json already exists"
          fi

      - name: Setup Node.js (with npm cache)
        uses: actions/setup-node@v4
        with:
          node-version: '${cfg.nodeVersion}'
          cache: 'npm'
          cache-dependency-path: '${npmCachePath}'
` : needsPnpm ? `
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '${cfg.nodeVersion}'
          cache: 'pnpm'
` : needsYarn ? `
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '${cfg.nodeVersion}'
          cache: 'yarn'
` : `
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '${cfg.nodeVersion}'
`;

  const buildWd = needsNpm && hasSubprojectPath
    ? projectWd
    : cfg.buildWorkingDirectory
      ? `\n        working-directory: ${cfg.buildWorkingDirectory}`
      : '';

  const installWd = needsNpm && hasSubprojectPath
    ? projectWd
    : cfg.installWorkingDirectory
      ? `\n        working-directory: ${cfg.installWorkingDirectory}`
      : '';

  const sitemapWd = hasSubprojectPath ? projectWd : '';
  const htmlMdWd = hasSubprojectPath ? projectWd : '';

  return `name: Deploy to Tencent COS

on:
  push:
    branches:
      - ${cfg.branch}
  workflow_dispatch:  # Allow manual trigger

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
${resolveStep}${pnpmSetupSteps}${yarnSetupSteps}${nodeSetupSteps}${npmSetupSteps}
      - name: Debug - list root files
        run: |
          echo "=== Root directory ==="
          ls -la
          echo "=== package files ==="
          ls -la package*.json pnpm-lock.yaml pnpm-workspace.yaml 2>/dev/null || echo "No package files found!"${debugSub}

      - name: Install dependencies${installWd}
        run: ${cfg.installCmd}

      - name: Build project${buildWd}
        run: ${cfg.buildCmd}

      - name: Generate sitemap and robots.txt${sitemapWd}
        env:
          SITE_URL: \${{ secrets.SITE_URL }}
        run: |${buildSiteUrlShell(cfg, { exportEnv: true })}

          FULL_URL="\${FULL_URL}" OUTPUT_DIR="${distDir}" node ${sitemapScript}

          echo "📄 sitemap.xml preview:"
          head -12 ${distDir}/sitemap.xml
          echo "📄 robots.txt:"
          cat ${distDir}/robots.txt

      - name: Install Playwright and Chromium browser
        run: |
          PW_DIR="\${RUNNER_TEMP}/playwright-ci"
          mkdir -p "$PW_DIR"
          cd "$PW_DIR"
          npm init -y >/dev/null 2>&1
          npm install playwright@1.49.1
          npx playwright install chromium --with-deps
          echo "PLAYWRIGHT_MODULE_PATH=$PW_DIR/node_modules/playwright" >> "$GITHUB_ENV"

      - name: Generate markdown for top-level pages${htmlMdWd}
        run: node ${htmlMdScript}
        env:
          PLAYWRIGHT_MODULE_PATH: \${{ env.PLAYWRIGHT_MODULE_PATH }}
          BASE_URL: http://127.0.0.1:4173
          OUTPUT_DIR: ${distDir}
          DIST_DIR: ${distDir}

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '${cfg.pythonVersion}'

      - name: Install coscmd
        run: pip install 'coscmd>=1.8.3.2'

      - name: Configure coscmd
        env:
          COS_SECRET_ID: \${{ secrets.COS_SECRET_ID }}
          COS_SECRET_KEY: \${{ secrets.COS_SECRET_KEY }}
          COS_BUCKET: \${{ secrets.COS_BUCKET }}
          COS_REGION: \${{ secrets.COS_REGION }}
        run: |
          echo "Checking COS configuration..."
          if [ -z "\${COS_SECRET_ID}" ]; then echo "ERROR: COS_SECRET_ID is empty!"; exit 1; fi
          if [ -z "\${COS_SECRET_KEY}" ]; then echo "ERROR: COS_SECRET_KEY is empty!"; exit 1; fi
          if [ -z "\${COS_BUCKET}" ]; then echo "ERROR: COS_BUCKET is empty!"; exit 1; fi
          if [ -z "\${COS_REGION}" ]; then echo "ERROR: COS_REGION is empty!"; exit 1; fi
          echo "All COS secrets are set (length: ID=\${#COS_SECRET_ID}, KEY=\${#COS_SECRET_KEY})"
          coscmd config -a "\${COS_SECRET_ID}" -s "\${COS_SECRET_KEY}" -b "\${COS_BUCKET}" -r "\${COS_REGION}"
          echo "coscmd config done"

      - name: Sync to COS (incremental diff + delete orphans)
        env:
          COS_TARGET_PATH: \${{ secrets.COS_TARGET_PATH || 'Default' }}
        run: |
          set -euo pipefail

          LOCAL_DIR="${uploadDist}"
          TARGET="\${COS_TARGET_PATH#/}"
          TARGET="\${TARGET%/}/"

          echo "📂 Local directory:  \${LOCAL_DIR}/"
          echo "☁️  COS prefix:       \${TARGET}"

          if [ ! -d "\${LOCAL_DIR}" ]; then
            echo "::error::Build output not found: \${LOCAL_DIR}"
            exit 1
          fi

          LOCAL_COUNT=\$(find "\${LOCAL_DIR}" -type f | wc -l | tr -d ' ')
          echo "📊 Local file count: \${LOCAL_COUNT}"

          echo "📋 Remote objects before sync (first 30):"
          coscmd list -r "\${TARGET}" 2>/dev/null | head -30 || echo "  (empty or first deploy)"

          echo ""
          echo "🔄 Incremental sync: upload changed files, skip identical (MD5), delete remote orphans..."
          # -r 递归  -s 增量对比 MD5  -f 跳过确认  --delete 删除远程多余文件
          coscmd upload -rfs --delete "\${LOCAL_DIR}/" "\${TARGET}"

          echo ""
          echo "✅ Sync completed"
          echo "📋 Remote objects after sync (last 20):"
          coscmd list -r "\${TARGET}" 2>/dev/null | tail -20 || true

      - name: Summary
        run: |
          echo "✅ Deployment completed!"
          echo "📦 Synced ${uploadDist}/ → COS: \${{ secrets.COS_TARGET_PATH || 'Default' }}/"
          echo "🔄 Incremental upload (MD5 diff) + remote orphan cleanup enabled"
          if [ -n "\${{ env.SITE_DISPLAY_URL }}" ]; then
            echo "🌐 Site URL: \${{ env.SITE_DISPLAY_URL }}"
            echo "📄 Sitemap: \${{ env.SITE_DISPLAY_URL }}/sitemap.xml"
            echo "🤖 Robots: \${{ env.SITE_DISPLAY_URL }}/robots.txt"
          fi
`;
}
