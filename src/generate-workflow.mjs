/**
 * 生成 .github/workflows/deploy-cos.yml 内容
 * @param {object} cfg - 用户配置 (来自 prompts)
 */
export function generateWorkflowYaml(cfg) {
  const sitemapScript = cfg.sitemapScript || 'scripts/generate-sitemap.mjs';
  const distDir = cfg.distDir || './dist';
  const needsPnpm = cfg.subprojectPackageManager === 'pnpm'
    || cfg.installCmd.startsWith('pnpm')
    || cfg.buildCmd.startsWith('pnpm');
  const needsNpm = cfg.subprojectPackageManager === 'npm'
    || cfg.installCmd.startsWith('npm');

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
${resolveStep}${pnpmSetupSteps}${nodeSetupSteps}
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
        run: |
          if [ -z "\${SITE_URL}" ]; then
            echo "⚠️  WARNING: SITE_URL is not set, skipping sitemap generation"
            exit 0
          fi

          if [[ "\${SITE_URL}" =~ ^https?:// ]]; then
            FULL_URL="\${SITE_URL}"
          else
            FULL_URL="${cfg.protocol}://\${SITE_URL}"
          fi

          echo "🌐 Using site URL: \${FULL_URL}"

          FULL_URL="\${FULL_URL}" OUTPUT_DIR="${distDir}" node ${sitemapScript}

          echo "📄 sitemap.xml preview:"
          head -12 ${distDir}/sitemap.xml
          echo "📄 robots.txt:"
          cat ${distDir}/robots.txt

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '${cfg.pythonVersion}'

      - name: Install coscmd
        run: pip install coscmd

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

      - name: Upload to COS (incremental + delete old files)
        env:
          COS_TARGET_PATH: \${{ secrets.COS_TARGET_PATH || 'Default' }}
        run: |
          coscmd upload -r ${uploadDist}/ "\${COS_TARGET_PATH}" --delete --force

      - name: Summary
        run: |
          echo "✅ Deployment completed!"
          echo "📦 Files uploaded from ${uploadDist}/ to COS path: \${{ secrets.COS_TARGET_PATH || 'Default' }}"
          echo "🗑️  Old files not present in the new build have been deleted"
          if [ -n "\${{ secrets.SITE_URL }}" ]; then
            SITE_URL="\${{ secrets.SITE_URL }}"
            if [[ "\${SITE_URL}" =~ ^https?:// ]]; then
              DISPLAY_URL="\${SITE_URL}"
            else
              DISPLAY_URL="${cfg.protocol}://\${SITE_URL}"
            fi
            echo "🌐 Site URL: \${DISPLAY_URL}"
            echo "📄 Sitemap: \${DISPLAY_URL}/sitemap.xml"
            echo "🤖 Robots: \${DISPLAY_URL}/robots.txt"
          fi
`;
}
