#!/usr/bin/env ts-node

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import "source-map-support/register";
import {
  createDeploymentConfig,
  DeploymentManager,
  generateVersion,
} from "../lib/utils/deploy-site";

const program = new Command();

program
  .name("deploy")
  .description("CLI for managing immutable deployments")
  .version("1.0.0");

// Global options
program
  .option("-b, --bucket <bucket>", "S3 bucket name")
  .option("-k, --kv-store <arn>", "CloudFront Key-Value Store ARN")
  .option("-d, --distribution <id>", "CloudFront Distribution ID")
  .option("-r, --region <region>", "AWS region", "us-east-1")
  .option("-c, --config <file>", "Configuration file path")
  .option("-e, --error-page <path>", "Relative path to error page file");

// Deploy command
program
  .command("deploy")
  .description("Deploy a new version")
  .argument("<path>", "Local path to deploy")
  .option(
    "-v, --version <version>",
    "Version to deploy (auto-generated if not provided)"
  )
  .option("--no-switch", "Deploy but don't switch to new version")
  .action(async (deployPath, options) => {
    try {
      const config = await loadConfig();
      const manager = new DeploymentManager(config);

      const version = options.version || generateVersion();
      console.log(`🚀 Deploying version: ${version}`);

      // Check if path exists
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

// Rollback command
program
  .command("rollback")
  .description("Rollback to a previous version")
  .argument("<version>", "Version to rollback to")
  .action(async (version) => {
    try {
      const config = await loadConfig();
      const manager = new DeploymentManager(config);

      console.log(`🔄 Rolling back to version: ${version}`);
      await manager.rollbackToVersion(version);
      console.log(`✅ Successfully rolled back to version: ${version}`);
    } catch (error) {
      console.error("❌ Rollback failed:", error);
      process.exit(1);
    }
  });

// List command
program
  .command("list")
  .description("List all deployed versions")
  .action(async () => {
    try {
      const config = await loadConfig();
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

// Cleanup command
program
  .command("cleanup")
  .description("Clean up old versions")
  .option("-k, --keep <count>", "Number of versions to keep", "5")
  .action(async (options) => {
    try {
      const config = await loadConfig();
      const manager = new DeploymentManager(config);

      const keepCount = parseInt(options.keep);
      console.log(`🧹 Cleaning up old versions, keeping ${keepCount}...`);

      await manager.cleanupOldVersions(keepCount);
      console.log("✅ Cleanup completed");
    } catch (error) {
      console.error("❌ Cleanup failed:", error);
      process.exit(1);
    }
  });

// Status command
program
  .command("status")
  .description("Show current deployment status")
  .action(async () => {
    try {
      const config = await loadConfig();
      const manager = new DeploymentManager(config);

      console.log("📊 Deployment Status");
      console.log(`Bucket: ${config.bucketName}`);
      console.log(`Distribution: ${config.distributionId}`);
      console.log(`Region: ${config.region}`);

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

async function loadConfig() {
  const options = program.opts() as any;
  console.log("debug", options);

  // Try to load from config file first
  if (options.config) {
    const configPath = path.resolve(options.config);
    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return createDeploymentConfig(
        configData.bucketName,
        configData.keyValueStoreArn,
        configData.distributionId,
        configData.region || "us-east-1",
        configData.errorPagePath
      );
    }
  }

  // Use command line options
  if (!options.bucket || !options.kvStore || !options.distribution) {
    console.error(
      "❌ Missing required options. Use --help for usage information."
    );
    console.error("Required: --bucket, --kv-store, --distribution");
    console.error("Or use --config to specify a configuration file.");
    process.exit(1);
  }

  return createDeploymentConfig(
    options.bucket,
    options.kvStore,
    options.distribution,
    options.region,
    options.errorPagePath
  );
}

program.parse(process.argv, { from: "node" });
