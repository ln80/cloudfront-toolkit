#!/usr/bin/env node

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import "source-map-support/register.js";
import {
  createDeploymentConfig,
  type DeploymentConfig,
  DeploymentManager,
  generateVersion,
  normalizeSitePath,
} from "../lib/deploy/deploy-site.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  const pkgPath = path.join(__dirname, "../../package.json");
  const raw = fs.readFileSync(pkgPath, "utf8");
  return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
}

interface GlobalCliOpts {
  bucket?: string;
  kvStore?: string;
  distribution?: string;
  region?: string;
  config?: string;
  errorPage?: string;
  site?: string;
  invalidate?: boolean;
}

interface DeployCmdOpts {
  version?: string;
  switch?: boolean;
  gitSha?: boolean;
}

const program = new Command();

program
  .name("cloudfront-toolkit")
  .description("CLI for versioned static sites on S3 + CloudFront KVS")
  .version(readPackageVersion());

program
  .option("-b, --bucket <bucket>", "S3 bucket name")
  .option("-k, --kv-store <arn>", "CloudFront Key-Value Store ARN")
  .option("-d, --distribution <id>", "CloudFront Distribution ID")
  .option("-r, --region <region>", "AWS region", "us-east-1")
  .option("-c, --config <file>", "Configuration file path")
  .option("-e, --error-page <path>", "Relative path to error page file")
  .option(
    "-s, --site <path>",
    "Multi-SPA site path prefix (overrides config file)"
  )
  .option(
    "--invalidate",
    "After switching KVS version, invalidate CloudFront cache /* (opt-in; usually not needed)"
  );

function getGlobals(): GlobalCliOpts {
  return program.optsWithGlobals() as GlobalCliOpts;
}

function loadConfig(): DeploymentConfig {
  const o = getGlobals();

  if (o.config) {
    const configPath = path.resolve(o.config);
    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(
        fs.readFileSync(configPath, "utf8")
      ) as {
        bucketName?: unknown;
        keyValueStoreArn?: unknown;
        distributionId?: unknown;
        region?: unknown;
        errorPagePath?: unknown;
        sitePath?: unknown;
        invalidateOnSwitch?: unknown;
      };
      const siteFromFile =
        typeof configData.sitePath === "string"
          ? configData.sitePath
          : undefined;
      const siteMerged = normalizeSitePath(o.site ?? siteFromFile);
      const invFromFile =
        typeof configData.invalidateOnSwitch === "boolean"
          ? configData.invalidateOnSwitch
          : undefined;
      const invalidateOnSwitch =
        o.invalidate === true
          ? true
          : typeof invFromFile === "boolean"
            ? invFromFile
            : undefined;
      return createDeploymentConfig(
        String(configData.bucketName),
        String(configData.keyValueStoreArn),
        String(configData.distributionId),
        String(configData.region ?? "us-east-1"),
        configData.errorPagePath !== undefined
          ? String(configData.errorPagePath)
          : undefined,
        siteMerged,
        invalidateOnSwitch
      );
    }
  }

  if (!o.bucket || !o.kvStore || !o.distribution) {
    console.error(
      "❌ Missing required options. Use --help for usage information."
    );
    console.error("Required: --bucket, --kv-store, --distribution");
    console.error("Or use --config to specify a configuration file.");
    process.exit(1);
  }

  return createDeploymentConfig(
    o.bucket,
    o.kvStore,
    o.distribution,
    o.region,
    o.errorPage,
    normalizeSitePath(o.site),
    o.invalidate === true ? true : undefined
  );
}

program
  .command("deploy")
  .description("Deploy a new version")
  .argument("<path>", "Local path to deploy")
  .option(
    "-v, --version <version>",
    "Version to deploy (auto-generated if not provided)"
  )
  .option("--no-switch", "Deploy but don't switch to new version")
  .option(
    "--git-sha",
    "Append short git SHA to auto-generated version (when in a git checkout)"
  )
  .action(async (deployPath: string, options: DeployCmdOpts) => {
    try {
      const config = loadConfig();
      const manager = new DeploymentManager(config);

      const version =
        options.version ||
        generateVersion({ appendGitSha: options.gitSha === true });
      console.log(`🚀 Deploying version: ${version}`);

      if (!fs.existsSync(deployPath)) {
        console.error(`❌ Path does not exist: ${deployPath}`);
        process.exit(1);
      }

      await manager.deployVersion(version, deployPath);

      if (options.switch !== false) {
        console.log(`🔄 Switching to version: ${version}`);
        await manager.updateCurrentVersion(version);
        console.log(
          `✅ Successfully deployed and switched to version: ${version}`
        );
      } else {
        console.log(
          `✅ Successfully deployed version: ${version} (not switched)`
        );
      }
    } catch (error) {
      console.error("❌ Deployment failed:", error);
      process.exit(1);
    }
  });

program
  .command("rollback")
  .description("Rollback to a previous version")
  .argument("<version>", "Version to rollback to")
  .action(async (version: string) => {
    try {
      const config = loadConfig();
      const manager = new DeploymentManager(config);

      console.log(`🔄 Rolling back to version: ${version}`);
      await manager.rollbackToVersion(version);
      console.log(`✅ Successfully rolled back to version: ${version}`);
    } catch (error) {
      console.error("❌ Rollback failed:", error);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List all deployed versions")
  .action(async () => {
    try {
      const config = loadConfig();
      const manager = new DeploymentManager(config);

      console.log("📋 Listing deployed versions...");
      const versions = await manager.listVersions();

      if (versions.length === 0) {
        console.log("No versions found");
      } else {
        console.log("Deployed versions:");
        versions.forEach((version: string, index: number): void => {
          console.log(`${index + 1}. ${version}`);
        });
      }
    } catch (error) {
      console.error("❌ Failed to list versions:", error);
      process.exit(1);
    }
  });

program
  .command("cleanup")
  .description("Clean up old versions")
  .option("-k, --keep <count>", "Number of versions to keep", "5")
  .action(async (options: { keep: string }) => {
    try {
      const config = loadConfig();
      const manager = new DeploymentManager(config);

      const keepCount = parseInt(options.keep, 10);
      console.log(`🧹 Cleaning up old versions, keeping ${keepCount}...`);

      await manager.cleanupOldVersions(keepCount);
      console.log("✅ Cleanup completed");
    } catch (error) {
      console.error("❌ Cleanup failed:", error);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show current deployment status")
  .action(async () => {
    try {
      const config = loadConfig();
      const manager = new DeploymentManager(config);

      console.log("📊 Deployment Status");
      console.log(`Bucket: ${config.bucketName}`);
      console.log(`Distribution: ${config.distributionId}`);
      console.log(`Region: ${config.region}`);
      if (config.sitePath) {
        console.log(`Site path: ${config.sitePath}`);
      }

      const versions = await manager.listVersions();
      console.log(`Total versions: ${versions.length}`);

      if (versions.length > 0) {
        console.log(`Latest version: ${versions[versions.length - 1]}`);
      }
    } catch (error) {
      console.error("❌ Failed to get status:", error);
      process.exit(1);
    }
  });

program.parse(process.argv, { from: "node" });
