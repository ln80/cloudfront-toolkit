import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "@jest/globals";
import { VersionedWebsite } from "./versioned-website.js";

describe("VersionedWebsite", () => {
  test("creates bucket, KVS, and response headers policy", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    new VersionedWebsite(stack, "Site", { projectName: "acme" });

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResourceProperties("AWS::CloudFront::KeyValueStore", {
      Name: "acme-version-store",
    });
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: "acme-ResponseHeadersPolicy",
      }),
    });
  });

  test("honors custom originPath", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack2");
    const site = new VersionedWebsite(stack, "Site", {
      projectName: "acme",
      originPath: "/custom-root",
    });
    expect(site.originPath).toBe("/custom-root");
  });
});
