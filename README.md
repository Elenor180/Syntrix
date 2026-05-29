# Syntrix

Syntrix is an AWS-connected proof of concept for document ingestion, OCR extraction, AI-assisted data structuring, and CSV export. This repository implements a focused processing portal: users upload PDF documents, trigger the extraction pipeline, preview the resulting dataset, and download the processed output.

The code here represents the document-processing engine and frontend workflow rather than the full multi-module Syntrix business platform.

## What This Repo Contains

- A React + TypeScript frontend built with Vite.
- AWS Amplify authentication wiring for Cognito-backed sign-in.
- Direct browser upload into an S3 ingestion bucket in `af-south-1`.
- Direct browser invocation of an existing orchestrator Lambda in `af-south-1`.
- Python Lambda handlers for Textract completion processing and Bedrock-based field extraction.
- CSV and metadata outputs written to S3.
- Processing records written to DynamoDB for audit and tracking.

## Current Scope

The code in this repo supports a single document-processing pipeline:

1. Upload a PDF.
2. Trigger processing.
3. Wait for OCR and AI extraction to finish.
4. Preview the extracted dataset.
5. Export the result as CSV.

This repository does not contain the full orchestration layer. The frontend is wired to existing AWS resources by ARN and bucket name, so some production components live outside the repo.

The broader architecture, limitations, scaling notes, and production-hardening recommendations are documented in [docs/syntrix-architecture-review.md](docs/syntrix-architecture-review.md).

## Architecture At A Glance

```text
Browser
  -> S3 ingestion bucket (af-south-1)
  -> existing Orchestrator Lambda (af-south-1)
  -> Textract workflow / temp bucket (eu-west-1)
  -> Textract completion Lambda (eu-west-1)
  -> Bedrock extraction Lambda (eu-west-1 -> af-south-1)
  -> Processed CSV + metadata in S3 (af-south-1)
  -> DynamoDB processing record
  -> Browser polls S3 and downloads CSV
```

## Tech Stack

- Frontend: React 19, TypeScript, Vite
- Auth: AWS Amplify / Cognito
- Compute: AWS Lambda
- OCR: Amazon Textract
- AI extraction: Amazon Bedrock
- Storage: Amazon S3
- Audit/state: Amazon DynamoDB
- Monitoring: CloudWatch

## Local Commands

```bash
npm install
npm run lint
npm run build
npm run dev
```

## Verification

The following commands were run successfully during the architecture review on April 16, 2026:

- `npm run lint`
- `npm run build`

## Important Notes

- The frontend is tightly coupled to specific AWS resources through `amplify_outputs.json` and hardcoded identifiers in `amplify/backend.ts`.
- The repo currently documents and implements a POC-oriented extraction workflow, not the broader Syntrix business platform seen on the live hosted site.
- The default Vite placeholder README has been replaced because it did not describe the actual project.
- Before production use, the system should move toward job IDs, tenant-scoped S3 prefixes, least-privilege IAM, and a backend API or queue-driven entry point instead of direct browser Lambda invocation.

## Deep Documentation

For the full architecture review, operational analysis, scaling discussion, risk register, and comparison with the hosted Syntrix site, see [docs/syntrix-architecture-review.md](docs/syntrix-architecture-review.md).
