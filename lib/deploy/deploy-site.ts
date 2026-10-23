import {
  CreateInvalidationCommand,
  CloudFrontClient,
} from "@aws-sdk/client-cloudfront";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import { SignatureV4MultiRegion } from "@aws-sdk/signature-v4-multi-region";
import * as fs from "node:fs";
import * as path from "path";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";

/** PutKey uses KVS-level optimistic locking; concurrent writers cause ConflictException. */
function isKeyValueStoreConflict(e: unknown): boolean {
  if (!e || typeof e !== "object") {
    return false;
  }
  const err = e as {
    name?: string;
    Code?: string;
    __type?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    err.name === "ConflictException" ||
    err.Code === "ConflictException" ||
    err.__type?.includes("ConflictException") === true ||
    err.$metadata?.httpStatusCode === 409
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Initialize signature-v4a package for multi-region signing
let signatureV4AInitialized = false;
async function initializeSignatureV4A(): Promise<void> {
  if (!signatureV4AInitialized) {
    try {
      await import("@aws-sdk/signature-v4a");
      signatureV4AInitialized = true;
    } catch (error) {
      console.warn("Failed to load @aws-sdk/signature-v4a:", error);
    }
  }
}

/** Normalize site path: remove leading/trailing slashes, reject empty. */
export function normalizeSitePath(sitePath: string | undefined): string | undefined {
  if (sitePath === undefined || sitePath === "") {
    return undefined;
  }
  const s = sitePath.replace(/^\/+|\/+$/g, "");
  if (!s) {
    return undefined;
  }
  return s;
}

/** KV store key for current version (must match viewer-request code). */
export function kvsKeyForSite(sitePath: string | undefined): string {
  const n = normalizeSitePath(sitePath);
  if (!n) {
    return "current-version";
  }
  return `current-version__${n.replaceAll("/", "__")}`;
}

export interface DeploymentConfig {
  bucketName: string;
  keyValueStoreArn: string;
  distributionId: string;
  region: string;
  errorPagePath?: string;
  /** Namespace for multi-SPA: S3 under artifacts/<sitePath>/... and per-site KV key. */
  sitePath?: string;
  /**
   * Opt-in: after KVS switch, call CloudFront `CreateInvalidation` (`/*`).
   * Normally unnecessary when viewer-request rewrites put the version in the URL path:
   * each release uses new cache keys and misses fetch fresh objects from S3.
   */
  invalidateOnSwitch?: boolean;
}

export interface UpdateCurrentVersionOptions {
  /** Override config: `true` forces invalidation, `false` skips even when config opts in. */
  invalidate?: boolean;
}

export class DeploymentManager {
  private s3: S3Client;
  private kvs: CloudFrontKeyValueStoreClient;
  private cloudFront?: CloudFrontClient;

  constructor(private config: DeploymentConfig) {
    this.s3 = new S3Client({ region: this.config.region });
    this.kvs = new CloudFrontKeyValueStoreClient({
      region: "us-east-1",
      signerConstructor: SignatureV4MultiRegion,
    });
  }

  private getCloudFront(): CloudFrontClient {
    if (!this.cloudFront) {
      this.cloudFront = new CloudFrontClient({ region: "us-east-1" });
    }
    return this.cloudFront;
  }

  private normalizedSite(): string | undefined {
    return normalizeSitePath(this.config.sitePath);
  }

  /** Prefix for listVersions: "artifacts/" or "artifacts/site/" */
  private artifactListingPrefix(): string {
    const site = this.normalizedSite();
    if (!site) {
      return "artifacts/";
    }
    return `artifacts/${site}/`;
  }

  private versionDirectoryPrefix(version: string): string {
    return `${this.artifactListingPrefix()}${version}/`;
  }

  private async ensureSignatureV4A(): Promise<void> {
    await initializeSignatureV4A();
  }

  private shouldInvalidate(explicit?: boolean): boolean {
    if (explicit === false) {
      return false;
    }
    if (explicit === true) {
      return true;
    }
    return this.config.invalidateOnSwitch === true;
  }

  private async createInvalidation(): Promise<void> {
    if (!this.config.distributionId) {
      return;
    }
    await this.getCloudFront().send(
      new CreateInvalidationCommand({
        DistributionId: this.config.distributionId,
        InvalidationBatch: {
          CallerReference: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          Paths: {
            Quantity: 1,
            Items: ["/*"],
          },
        },
      })
    );
    console.log("Created CloudFront invalidation for /*");
  }

  /**
   * Deploy a new version to S3
   */
  async deployVersion(version: string, localPath: string): Promise<void> {
    console.log(`Deploying version ${version} to S3...`);

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local path does not exist: ${localPath}`);
    }

    const filesToUpload = await this.getAllFiles(localPath);
    console.log(`Found ${filesToUpload.length} files to upload`);

    const batchSize = 10;
    for (let i = 0; i < filesToUpload.length; i += batchSize) {
      const batch = filesToUpload.slice(i, i + batchSize);
      await this.uploadBatch(version, localPath, batch);
      console.log(
        `Uploaded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(filesToUpload.length / batchSize)}`
      );
    }

    console.log(`Successfully deployed version ${version} to S3`);
  }

  private async getAllFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];
    const readdir = promisify(fs.readdir);
    const stat = promisify(fs.stat);
    const items = await readdir(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        const subFiles = await this.getAllFiles(fullPath);
        files.push(...subFiles);
      } else {
        files.push(fullPath);
      }
    }
    return files;
  }

  private async uploadBatch(
    version: string,
    localPath: string,
    files: string[]
  ): Promise<void> {
    await Promise.all(
      files.map(async (filePath) => {
        const relativePath = path.relative(localPath, filePath);
        const s3Key = `${this.versionDirectoryPrefix(version)}${relativePath}`;

        const body = fs.createReadStream(filePath);

        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.config.bucketName,
            Key: s3Key,
            Body: body,
            ContentType: this.getContentType(filePath),
          })
        );

        if (
          this.config.errorPagePath &&
          relativePath === this.config.errorPagePath
        ) {
          console.log(`Deploying error page to dedicated path: ${relativePath}`);
          const errorKey = this.errorPageStandaloneKey(relativePath);
          const errBody = fs.createReadStream(filePath);
          await this.s3.send(
            new PutObjectCommand({
              Bucket: this.config.bucketName,
              Key: errorKey,
              Body: errBody,
              ContentType: this.getContentType(filePath),
            })
          );
        }
      })
    );
  }

  /** Key for error page mirrored at predictable path (see README). */
  private errorPageStandaloneKey(relativePath: string): string {
    const site = this.normalizedSite();
    if (!site) {
      return `artifacts/${relativePath}`;
    }
    return `artifacts/${site}/${relativePath}`;
  }

  private getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: { [key: string]: string } = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      // .mjs must carry a JavaScript MIME or browsers reject it under strict
      // module-script MIME checking (e.g. the pdf.js `type: "module"` worker).
      ".mjs": "text/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".webp": "image/webp",
      ".avif": "image/avif",
      ".wasm": "application/wasm",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".eot": "application/vnd.ms-fontobject",
      ".txt": "text/plain",
      ".xml": "application/xml",
      ".pdf": "application/pdf",
    };

    return contentTypes[ext] ?? "application/octet-stream";
  }

  /**
   * Update the current version in CloudFront Key-Value Store
   */
  async updateCurrentVersion(
    version: string,
    options?: UpdateCurrentVersionOptions
  ): Promise<void> {
    console.log(`Updating current version to ${version}...`);
    await this.ensureSignatureV4A();

    const kvsKey = kvsKeyForSite(this.config.sitePath);
    const maxAttempts = 10;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { ETag } = await this.kvs.send(
        new DescribeKeyValueStoreCommand({
          KvsARN: this.config.keyValueStoreArn,
        })
      );

      if (!ETag) {
        throw new Error(
          "DescribeKeyValueStore returned no ETag; cannot perform conditional PutKey"
        );
      }

      console.log(`Update KVS using ETAG ${ETag} (attempt ${attempt}/${maxAttempts})`);

      try {
        await this.kvs.send(
          new PutKeyCommand({
            Key: kvsKey,
            Value: version,
            KvsARN: this.config.keyValueStoreArn,
            IfMatch: ETag,
          })
        );
        console.log(`Successfully updated current version to ${version}`);
        break;
      } catch (e: unknown) {
        const retryable =
          isKeyValueStoreConflict(e) && attempt < maxAttempts;
        if (!retryable) {
          throw e;
        }
        const backoffMs = Math.min(2500, 75 * 2 ** (attempt - 1));
        console.warn(
          `Key Value Store busy or concurrent update (ConflictException); retrying in ${backoffMs}ms…`
        );
        await sleepMs(backoffMs);
      }
    }

    const inv = this.shouldInvalidate(options?.invalidate);
    if (inv) {
      await this.createInvalidation();
    }
  }

  async rollbackToVersion(
    version: string,
    options?: UpdateCurrentVersionOptions
  ): Promise<void> {
    console.log(`Rolling back to version ${version}...`);
    await this.updateCurrentVersion(version, options);
  }

  /**
   * List deployed version folder names (lexicographic order from S3; sort applied for cleanup semantics).
   */
  async listVersions(): Promise<string[]> {
    console.log("Listing deployed versions...");
    const base = this.artifactListingPrefix();

    const result = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucketName,
        Prefix: base,
        Delimiter: "/",
      })
    );

    const versions: string[] =
      result.CommonPrefixes?.map((p: { Prefix?: string }) => {
        const full = p.Prefix ?? "";
        if (!full.startsWith(base)) {
          return "";
        }
        return full.slice(base.length).replace(/\/$/, "");
      }).filter(Boolean) ?? [];

    versions.sort();
    console.log("Deployed versions:", versions);
    return versions;
  }

  /**
   * Keep the last keepCount versions (by sorted order); delete older deployment folders.
   * Versions should use monotonic strings (e.g. ISO timestamps) so lexicographic order matches recency.
   */
  async cleanupOldVersions(keepCount: number = 5): Promise<void> {
    console.log(`Cleaning up old versions, keeping ${keepCount}...`);

    const versions = await this.listVersions();
    if (versions.length <= keepCount) {
      console.log("Nothing to clean up");
      return;
    }

    const versionsToDelete = versions.slice(0, versions.length - keepCount);

    for (const version of versionsToDelete) {
      console.log(`Deleting version ${version}...`);
      const listParams = {
        Bucket: this.config.bucketName,
        Prefix: this.versionDirectoryPrefix(version),
      };

      let continuationToken: string | undefined;
      do {
        const objects = await this.s3.send(
          new ListObjectsV2Command({
            ...listParams,
            ContinuationToken: continuationToken,
          })
        );
        const contents = objects.Contents;
        if (contents && contents.length > 0) {
          const chunkSize = 1000;
          for (let i = 0; i < contents.length; i += chunkSize) {
            const chunk = contents.slice(i, i + chunkSize);
            await this.s3.send(
              new DeleteObjectsCommand({
                Bucket: this.config.bucketName,
                Delete: {
                  Objects: chunk.map((obj: { Key?: string }) => ({ Key: obj.Key! })),
                },
              })
            );
          }
        }
        continuationToken = objects.IsTruncated
          ? objects.NextContinuationToken
          : undefined;
      } while (continuationToken);
    }

    console.log(`Cleaned up ${versionsToDelete.length} old versions`);
  }
}

export interface GenerateVersionOptions {
  /** Append short git SHA when in a git repo (best-effort). */
  appendGitSha?: boolean;
}

export function generateVersion(options?: GenerateVersionOptions): string {
  const now = new Date();
  let v = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (options?.appendGitSha) {
    try {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (sha) {
        v += `-${sha}`;
      }
    } catch {
      // not a git checkout or git missing
    }
  }
  return v;
}

/**
 * Build deployment configuration (backward compatible: trailing optional args).
 */
export function createDeploymentConfig(
  bucketName: string,
  keyValueStoreArn: string,
  distributionId: string,
  region?: string,
  errorPagePath?: string,
  sitePath?: string,
  invalidateOnSwitch?: boolean
): DeploymentConfig {
  return {
    bucketName,
    keyValueStoreArn,
    distributionId,
    region: region ?? "us-east-1",
    errorPagePath,
    sitePath: normalizeSitePath(sitePath),
    invalidateOnSwitch,
  };
}
