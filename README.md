# @ln80/cloudfront-toolkit

TypeScript toolkit for **versioned static sites** on S3 + CloudFront with a **Key Value Store** (KVS) for instant version switching, plus a small CLI.

## Install

```bash
npm install @ln80/cloudfront-toolkit
```

`aws-cdk-lib` and `constructs` are **optional peer dependencies**: install them only if you use the CDK construct. Deploy-only usage can rely on the `./deploy` entry without CDK.

## Package entry points

| Import path | Purpose |
|-------------|--------|
| `@ln80/cloudfront-toolkit` | Full library (CDK + deploy runtime). |
| `@ln80/cloudfront-toolkit/cdk` | CDK constructs (same module as `/constructs`). |
| `@ln80/cloudfront-toolkit/constructs` | Barrel export for constructs (prefer over deep `dist/` paths). |
| `@ln80/cloudfront-toolkit/deploy` | Deploy runtime only (`DeploymentManager`, `createDeploymentConfig`, …). |

Prefer **`/cdk`** or **`/constructs`** in application code. Some tools still resolve internal paths like `@ln80/cloudfront-toolkit/dist/lib/constructs`; those URL shapes are included in `package.json` `exports` for compatibility with `ts-node` / CDK.

## CLI

After install, the `cloudfront-toolkit` command is available (or `npx @ln80/cloudfront-toolkit`).

```bash
cloudfront-toolkit --config deploy.json deploy ./dist
cloudfront-toolkit --site admin --config deploy.json deploy ./dist
cloudfront-toolkit list --config deploy.json
```

### Using the CLI in CI (`npx`)

The published binary name is **`cloudfront-toolkit`**, which differs from the package name. Call it explicitly so `npx` knows what to run:

```bash
# Pin a version in CI for reproducible builds
npx --yes --package=@ln80/cloudfront-toolkit@0.1.3 cloudfront-toolkit --config deploy.json deploy ./dist
```

Same pattern for other subcommands:

```bash
npx --yes --package=@ln80/cloudfront-toolkit@0.1.3 cloudfront-toolkit --config deploy.json list
```

Requirements in CI:

- **AWS credentials** with permission for S3 uploads, CloudFront KVS writes, and (only if you use `--invalidate`) `cloudfront:CreateInvalidation`. Typical setups use OIDC (`aws-actions/configure-aws-credentials` on GitHub) or stored secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`).
- **`deploy.json`** (or equivalent): commit a minimal config, or generate it from secrets (bucket name, KVS ARN, distribution id).

Minimal **GitHub Actions** outline:

```yaml
jobs:
  deploy-site:
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # for OIDC to AWS
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci && npm run build   # your app artifact in ./dist (example)
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: us-east-1
      - name: Deploy to S3 / switch version via KVS
        run: |
          npx --yes --package=@ln80/cloudfront-toolkit@0.1.3 cloudfront-toolkit \
            --config deploy.json deploy ./dist
```

Adjust `deploy.json` path, Node version, and AWS auth to match your account.

Global options apply to all subcommands: `--bucket`, `--kv-store`, `--distribution`, `--region`, `--config`, `--error-page`, `--site`, `--invalidate`.

- **`--site`**: multi-SPA namespace (see below). Overrides `sitePath` from the JSON config when both are set.
- **`--invalidate`**: opt-in CloudFront `CreateInvalidation` for `/*` after updating the KVS. **Usually unnecessary**: viewer-request runs on each request (not cached like origin responses) and rewrites to a path that includes the active version, so the edge cache keys change when you switch versions—new paths miss cache and load fresh from S3. Use `--invalidate` only if you also serve cacheable URLs that do **not** include the version segment (or similar edge cases).

### JSON config file

```json
{
  "bucketName": "my-bucket",
  "keyValueStoreArn": "arn:aws:cloudfront::123456789012:key-value-store/...",
  "distributionId": "E1234567890ABC",
  "region": "us-east-1",
  "errorPagePath": "index.html",
  "sitePath": "admin",
  "invalidateOnSwitch": false
}
```

Set **`invalidateOnSwitch`: true** only if you explicitly want a full distribution invalidation after each switch.

### KVS `ConflictException` (“not in expected state”)

CloudFront **PutKey** is conditional on the store **ETag**. If something else updates that Key Value Store between your read and write (another deploy, CI job, or script), AWS returns **409 / ConflictException**. From **v0.1.3** the CLI retries with a fresh `DescribeKeyValueStore` and backoff. If errors continue, ensure **only one deploy at a time** per KVS (CI concurrency group, or stagger pipelines).

## Multi-SPA (`sitePath`)

Use one bucket + distribution + KVS for several Vite (or other) apps under different URL prefixes (e.g. `/admin`, `/apps/dashboard`).

- **Deploy** with the same flags or config as usual, plus **`sitePath`** (CLI `--site` or JSON `sitePath`).
- Objects are stored under `artifacts/<sitePath>/<version>/…` (or `artifacts/<version>/…` when `sitePath` is omitted — backward compatible).
- KVS keys: `current-version` when there is no site; `current-version__apps__vite` for `sitePath` `apps/vite` (slashes → `__`). Implement your **viewer-request CloudFront Function** to read the right key and rewrite URIs; keep it in sync with your framework (Vite base paths, etc.). Use `kvsKeyForSite` from `@ln80/cloudfront-toolkit/deploy` so key names match what `DeploymentManager` writes.

## CDK: `VersionedWebsite`

- **`originPath`**: defaults to `/artifacts`. It must match how objects are addressed from CloudFront to S3 together with **your** viewer-request rewrites (defaults align with `DeploymentManager`’s `artifacts/…` prefix).
- **`viewerRequestFunctionFromFile(id, path)`**: wire your own CF Function JavaScript (`FunctionCode.fromFile`). Routing logic stays in your repo, not in this construct.

## Publishing

The package is ESM (`"type": "module"`). `npm run build` compiles into `dist/`. `prepublishOnly` runs build + tests.

## License

See your organization’s policy; add a `LICENSE` file when publishing publicly.
