# @ln80/cloudfront-toolkit

A TypeScript CDK toolkit to manage versioned S3 websites with CloudFront KV store, plus a CLI for easy deployment.

## Features

- CDK construct: `VersionedWebsite`
  - Creates S3 bucket
  - CloudFront origin
  - KV store for versioning / rollback
- CLI: `ln80-deploy-site` for deploying websites from your project

---

## Installation

Install directly from GitHub:

```bash
npm install git+https://github.com/your-org/cloudfront-toolkit.git
```
