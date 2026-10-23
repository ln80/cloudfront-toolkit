import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface VersionedWebsiteProps {
  projectName: string;
  bucket?: s3.IBucket;
  /**
   * Origin path on the S3 REST API path (prefix before object key tail).
   * Must align with `DeploymentManager` (default deploy prefix is `artifacts/…`).
   * @default '/artifacts'
   */
  originPath?: string;
}

export class VersionedWebsite extends Construct {
  readonly bucket: s3.IBucket;
  readonly origin: cloudfront.IOrigin;
  readonly kvStore: cloudfront.KeyValueStore;
  readonly responseHeadersPolicy: cloudfront.ResponseHeadersPolicy;
  readonly originPath: string;

  constructor(scope: Construct, id: string, props: VersionedWebsiteProps) {
    super(scope, id);

    const { projectName, bucket } = props;

    this.originPath = props.originPath ?? "/artifacts";

    this.bucket =
      bucket ??
      new s3.Bucket(this, `${props.projectName}-Bucket`, {
        bucketName: `${props.projectName}-artifacts`.toLowerCase(),
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        versioned: true,
      });

    this.origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originPath: this.originPath,
      originId: "website-origin",
    });

    this.kvStore = new cloudfront.KeyValueStore(this, "VersionStore", {
      keyValueStoreName: `${props.projectName}-version-store`,
      comment: "Stores current deployment version for immutable deployments",
    });

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

  /**
   * Attach a viewer-request CloudFront Function from your own JavaScript source.
   * Routing (including multi-SPA) is an application concern — implement it here and
   * align KVS keys with `kvsKeyForSite` / deploy `sitePath` from `@ln80/cloudfront-toolkit/deploy`.
   */
  public viewerRequestFunctionFromFile(
    id: string,
    filePath: string
  ): cloudfront.Function {
    return new cloudfront.Function(this, id, {
      code: cloudfront.FunctionCode.fromFile({ filePath }),
      comment:
        "Routes requests to versioned S3 paths for immutable deployments",
      keyValueStore: this.kvStore,
    });
  }

  /**
   * @deprecated Use `viewerRequestFunctionFromFile`.
   */
  public changeUriFunctionFromFile(filePath: string): cloudfront.Function {
    return this.viewerRequestFunctionFromFile("ChangeUriFunction", filePath);
  }
}
