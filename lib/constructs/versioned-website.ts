import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as fs from "fs";

export interface VersionedWebsiteProps {
  projectName: string; // used as prefix for resources
  bucket?: s3.IBucket; // optional existing S3 bucket; creates a new one if not provided
  //   versioned?: boolean;       // enable S3 versioning
  //   createKvStore?: boolean;   // whether to create CF KV store
}

export class VersionedWebsite extends Construct {
  readonly bucket: s3.IBucket;
  readonly origin: cloudfront.IOrigin;
  readonly kvStore: cloudfront.KeyValueStore;
  readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;

  constructor(scope: Construct, id: string, props: VersionedWebsiteProps) {
    super(scope, id);

    const { projectName, bucket } = props;

    // S3 bucket to hold website assets - use provided bucket or create a new one
    this.bucket =
      bucket ??
      new s3.Bucket(this, `${props.projectName}-Bucket`, {
        bucketName: `${props.projectName}-artifacts`.toLowerCase(),
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        versioned: true,
      });

    // S3 origin for CloudFront
    this.origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originPath: "/artifacts",
      originId: "website-origin",
    });

    // CloudFront KV store for version/rollback tracking
    this.kvStore = new cloudfront.KeyValueStore(this, "VersionStore", {
      keyValueStoreName: `${props.projectName}-version-store`,
      comment: "Stores current deployment version for immutable deployments",
    });

    // Response headers policy to set security headers
    this.responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "ResponseHeadersPolicy",
      {
        responseHeadersPolicyName: `${projectName}-ResponseHeadersPolicy`,
        comment: `${projectName}-ResponseHeadersPolicy`,
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: false,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.seconds(31536000),
            includeSubdomains: true,
            override: true,
          },
          xssProtection: { protection: true, modeBlock: true, override: true },
        },
        removeHeaders: ["age", "date"],
      }
    );
  }

  public changeUriFunctionFromFile(path: string): cloudfront.Function {
    // Read the CloudFront function code
    const functionCode = fs.readFileSync(path, "utf8");

    // Create CloudFront Function
    const changeUriFunction = new cloudfront.Function(
      this,
      "ChangeUriFunction",
      {
        code: cloudfront.FunctionCode.fromInline(functionCode),
        comment:
          "Routes requests to versioned S3 paths for versionned deployments",
        keyValueStore: this.kvStore,
      }
    );

    return changeUriFunction;
  }
}
