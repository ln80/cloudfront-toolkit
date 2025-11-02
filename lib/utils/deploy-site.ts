#!/usr/bin/env ts-node

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import { SignatureV4MultiRegion } from "@aws-sdk/signature-v4-multi-region";

import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore";

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

export interface DeploymentConfig {
  bucketName: string;
  keyValueStoreArn: string;
  distributionId: string;
  region: string;
  errorPagePath?: string; // Optional relative path to error page
}

export class DeploymentManager {
  private s3: S3Client;
  private kvs: CloudFrontKeyValueStoreClient;

  constructor(private config: DeploymentConfig) {
    this.s3 = new S3Client({ region: this.config.region });
    this.kvs = new CloudFrontKeyValueStoreClient({
      region: "us-east-1",
      signerConstructor: SignatureV4MultiRegion,
    });
  }

  /**
   * Ensure signature-v4a package is loaded for multi-region signing
   */
  private async ensureSignatureV4A(): Promise<void> {
    await initializeSignatureV4A();
  }

  /**
   * Deploy a new version to S3
   */
  async deployVersion(version: string, localPath: string): Promise<void> {
    console.log(`Deploying version ${version} to S3...`);

    // Validate local path exists
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local path does not exist: ${localPath}`);
    }

    // Get all files to upload
    const filesToUpload = await this.getAllFiles(localPath);
    console.log(`Found ${filesToUpload.length} files to upload`);

    // Upload files in batches
    const batchSize = 10; // Upload 10 files at a time
    for (let i = 0; i < filesToUpload.length; i += batchSize) {
      const batch = filesToUpload.slice(i, i + batchSize);
      await this.uploadBatch(version, localPath, batch);
      console.log(
        `Uploaded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(filesToUpload.length / batchSize)}`
      );
    }

    console.log(`Successfully deployed version ${version} to S3`);
  }

  /**
   * Get all files recursively from a directory
   */
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

  /**
   * Upload a batch of files to S3
   */
  private async uploadBatch(
    version: string,
    localPath: string,
    files: string[]
  ): Promise<void> {
    const uploadPromises = files.map(async (filePath) => {
      const relativePath = path.relative(localPath, filePath);
      const s3Key = `artifacts/${version}/${relativePath}`;

      const fileContent = fs.readFileSync(filePath);

      const uploadParams = {
        Bucket: this.config.bucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: this.getContentType(filePath),
      };

      await this.s3.send(new PutObjectCommand(uploadParams));

      // If this is the error page, also deploy it to the dedicated error page path
      if (
        this.config.errorPagePath &&
        relativePath === this.config.errorPagePath
      ) {
        console.log(`Deploying error page to dedicated path: ${relativePath}`);
        const errorPageUploadParams = {
          Bucket: this.config.bucketName,
          Key: `artifacts/${this.config.errorPagePath}`,
          Body: fileContent,
          ContentType: this.getContentType(filePath),
        };
        await this.s3.send(new PutObjectCommand(errorPageUploadParams));
      }
    });

    await Promise.all(uploadPromises);
  }

  /**
   * Determine content type based on file extension
   */
  private getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: { [key: string]: string } = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".eot": "application/vnd.ms-fontobject",
      ".txt": "text/plain",
      ".xml": "application/xml",
      ".pdf": "application/pdf",
    };

    return contentTypes[ext] || "application/octet-stream";
  }

  /**
   * Update the current version in CloudFront Key-Value Store
   */
  async updateCurrentVersion(version: string): Promise<void> {
    console.log(`Updating current version to ${version}...`);

    // Ensure signature-v4a is loaded for multi-region signing
    await this.ensureSignatureV4A();

    const { ETag } = await this.kvs.send(
      new DescribeKeyValueStoreCommand({
        KvsARN: this.config.keyValueStoreArn,
      })
    );

    console.log("Update KVS using ETAG " + ETag);

    await this.kvs.send(
      new PutKeyCommand({
        Key: "current-version",
        Value: version,
        KvsARN: this.config.keyValueStoreArn,
        IfMatch: ETag,
      })
    );

    console.log(`Successfully updated current version to ${version}`);
  }

  /**
   * Rollback to a previous version
   */
  async rollbackToVersion(version: string): Promise<void> {
    console.log(`Rolling back to version ${version}...`);

    await this.updateCurrentVersion(version);
    console.log(`Successfully rolled back to version ${version}`);
  }

  /**
   * List all deployed versions
   */
  async listVersions(): Promise<string[]> {
    console.log("Listing deployed versions...");

    const listParams = {
      Bucket: this.config.bucketName,
      Prefix: "artifacts/",
      Delimiter: "/",
    };

    const result = await this.s3.send(new ListObjectsV2Command(listParams));
    const versions =
      (result.CommonPrefixes?.map((prefix: any) =>
        prefix.Prefix?.replace("artifacts/", "").replace("/", "")
      ).filter(Boolean) as string[]) || [];

    console.log("Deployed versions:", versions);
    return versions;
  }

  /**
   * Clean up old versions (keep last N versions)
   */
  async cleanupOldVersions(keepCount: number = 5): Promise<void> {
    console.log(`Cleaning up old versions, keeping ${keepCount}...`);

    const versions = await this.listVersions();
    const versionsToDelete = versions.slice(0, -keepCount);

    for (const version of versionsToDelete) {
      console.log(`Deleting version ${version}...`);
      // Delete all objects in the version folder
      const listParams = {
        Bucket: this.config.bucketName,
        Prefix: `artifacts/${version}/`,
      };

      const objects = await this.s3.send(new ListObjectsV2Command(listParams));
      if (objects.Contents && objects.Contents.length > 0) {
        const deleteParams = {
          Bucket: this.config.bucketName,
          Delete: {
            Objects: objects.Contents.map((obj: any) => ({ Key: obj.Key! })),
          },
        };

        await this.s3.send(new DeleteObjectsCommand(deleteParams));
      }
    }

    console.log(`Cleaned up ${versionsToDelete.length} old versions`);
  }
}

/**
 * Generate a version string based on current timestamp
 */
export function generateVersion(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Create deployment configuration from CDK outputs
 */
export function createDeploymentConfig(
  bucketName: string,
  keyValueStoreArn: string,
  distributionId: string,
  region: string = "us-east-1",
  errorPagePath?: string
): DeploymentConfig {
  return {
    bucketName,
    keyValueStoreArn,
    distributionId,
    region,
    errorPagePath,
  };
}
