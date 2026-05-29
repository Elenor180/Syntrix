# Syntrix Architecture Review

Last reviewed: April 16, 2026

## 1. Executive Summary

Syntrix, as represented in this repository, is an AWS-based proof of concept for automating document extraction. The implemented pipeline ingests PDF files, uses Textract for OCR, uses Bedrock to classify and structure the extracted content, and produces CSV outputs for downstream review and export.

The architecture shows a strong decoupled-processing direction, but it is still at POC maturity. The main strengths are:

- Clear separation between ingestion, OCR, AI extraction, and output storage.
- Good use of managed AWS services for asynchronous processing.
- Evidence that the design can grow into a more robust workflow platform.

The main constraints are:

- Hardcoded infrastructure bindings.
- Cross-region processing complexity.
- Direct browser-to-Lambda invocation.
- Broad bucket permissions.
- Filename-based correlation instead of immutable job IDs.
- Scaling limits caused by polling and S3 list scans.

This review also compares the AWS implementation in this repo with the live hosted Syntrix application available at `https://syntrixprocure.co.za`.

## 2. Scope of This Review

This review is based on:

- The source code in this repository.
- The generated `amplify_outputs.json`.
- The live public site response and frontend bundle available on April 16, 2026.
- Local verification using `npm run lint` and `npm run build`.

Important limitation:

- The repo does not contain the orchestrator Lambda implementation.
- The repo does not contain the full infrastructure that starts Textract jobs, manages queues, or handles cross-service orchestration.
- Any queueing or throttling controls outside the included files are therefore inferred as external dependencies, not documented as implemented here.

## 3. What Syntrix Currently Does

The current repo implements a focused AI extraction portal:

1. A signed-in user selects a PDF in the browser.
2. The file is uploaded to `syntrix-doc-ingestion` in `af-south-1`.
3. The browser directly invokes an existing orchestrator Lambda.
4. The orchestrator is expected to copy or prepare the file for Textract processing.
5. A Textract completion Lambda collects OCR results and writes a normalized JSON file into a temporary EU bucket.
6. A Bedrock extraction Lambda reads the OCR JSON, classifies the document, extracts fields, writes a CSV to the processed bucket, writes metadata to S3, and writes an audit item to DynamoDB.
7. The browser polls S3 for output and allows the user to preview and export the CSV.

## 4. Implemented Architecture

### 4.1 Frontend

The frontend is implemented in React and TypeScript. It is intentionally small and task-oriented.

Key responsibilities:

- Authenticate users with Amplify and Cognito.
- Upload files to S3.
- Invoke the existing Lambda orchestrator.
- Poll S3 for extracted output.
- Preview the dataset.
- Export the final CSV.

Relevant files:

- `src/main.tsx`
- `src/App.tsx`
- `amplify/backend.ts`
- `amplify_outputs.json`

### 4.2 Backend and Service Wiring

The backend definition is a thin Amplify wrapper over existing AWS resources rather than a complete infrastructure-as-code deployment.

Observed AWS bindings:

| Component | Role | Region | Evidence |
| --- | --- | --- | --- |
| Cognito User Pool / Identity Pool | Authentication | `af-south-1` | `amplify_outputs.json` |
| S3 ingestion bucket | Browser upload source | `af-south-1` | `src/App.tsx`, `amplify/backend.ts` |
| Orchestrator Lambda | Starts processing | `af-south-1` | `src/App.tsx`, `amplify/backend.ts` |
| Temp processing bucket | Intermediate Textract JSON / copied document staging | `eu-west-1` | `textract_completion_lambda.py`, `amplify_outputs.json` |
| Textract | OCR extraction | `eu-west-1` | `textract_completion_lambda.py` |
| Bedrock runtime | AI extraction | `eu-west-1` | `bedrock_extraction_lambda.py` |
| Processed bucket | CSV + metadata output | `af-south-1` | `src/App.tsx`, `bedrock_extraction_lambda.py` |
| DynamoDB | Processing audit / extracted data record | `eu-west-1` | `bedrock_extraction_lambda.py` |

### 4.3 End-to-End Flow

```text
User signs in with Cognito
  -> Uploads PDF to S3 ingestion bucket in af-south-1
  -> Browser invokes existing orchestrator Lambda in af-south-1
  -> Orchestrator triggers Textract processing via external workflow
  -> Textract completion handler receives SNS event in eu-west-1
  -> Completion handler aggregates OCR blocks and writes JSON to temp bucket
  -> Bedrock extraction handler reads OCR JSON and calls Bedrock model
  -> CSV is written to processed bucket in af-south-1
  -> Metadata is written to extracted/.../metadata.json
  -> DynamoDB receives processing record
  -> Browser polls S3 until result appears
  -> User previews and exports CSV
```

## 5. Strengths of the Current Design

### 5.1 Good Decoupling of Work Stages

The solution separates ingestion, OCR, extraction, storage, and presentation. That is the right architectural direction for scale because each stage can evolve independently.

### 5.2 Managed Service Strategy

Using S3, Lambda, Textract, Bedrock, DynamoDB, and Cognito reduces the need to maintain custom infrastructure.

### 5.3 Practical POC Focus

The repo focuses on a narrow workflow instead of attempting to solve the full business platform in one step. That lowers implementation risk for a proof of concept.

### 5.4 Built-In Audit Trail Foundations

The processed output is stored in S3, metadata is persisted, and DynamoDB captures a processing record. That is a strong foundation for traceability and compliance reporting.

## 6. Current Challenges and Risks

### 6.1 Hardcoded Environment Coupling

The current implementation is tightly bound to one AWS account and a fixed set of resource names and ARNs.

Examples:

- `src/App.tsx` hardcodes `syntrix-doc-ingestion` and `af-south-1`.
- `amplify/backend.ts` imports fixed bucket ARNs.
- `amplify/backend.ts` grants invoke access to a fixed Lambda ARN.
- `amplify_outputs.json` contains concrete pool IDs, bucket names, and function ARNs.

Impact:

- Harder to create dev, test, staging, and production environments.
- Harder to replicate the platform for multiple customers or regions.
- Higher chance of deployment mistakes when resources change.

### 6.2 Browser Directly Invokes Lambda

The browser invokes the orchestrator Lambda directly instead of going through an API Gateway, application backend, or queue entry point.

Evidence:

- `src/App.tsx` uses `@aws-sdk/client-lambda` to call the function directly.

Trade-off:

- Fast to implement.
- Less controlled than a server-side API boundary.
- Makes authorization, request validation, throttling, and job tracking harder to centralize.

### 6.3 Broad Bucket Access for Authenticated Users

Authenticated users are granted `PutObject`, `GetObject`, `ListBucket`, `DeleteObject`, and `GetBucketLocation` on both ingestion and processed buckets.

Evidence:

- `amplify/backend.ts`

Impact:

- Any authenticated user may be able to list or delete artifacts outside their own workload unless additional bucket policies or key-prefix controls exist externally.
- This is acceptable for a POC but too broad for a production multi-tenant system.

### 6.4 Filename-Based Correlation Is Fragile

The pipeline uses the original filename as the key identity for processing and retrieval.

Evidence:

- Upload path: `raw/<file.name>` in `src/App.tsx`
- Output path: `processed/raw/<file.name>.csv`
- Metadata lookup searches by `file_name`

Risks:

- Two users uploading the same filename can overwrite or cross-reference each other’s outputs.
- There is no durable job ID exposed to the frontend.
- Multi-tenant isolation is weak.

### 6.5 Output Discovery Does Not Scale Well

The frontend polls S3 every 5 seconds and, if no exact processed CSV is found, it scans metadata files under `extracted/` and downloads metadata objects until it finds a matching filename.

Evidence:

- `src/App.tsx`

Impact:

- Ongoing list operations increase with dataset size.
- Metadata scans become progressively slower.
- User latency will increase as processed volume grows.
- S3 request costs will rise under concurrent usage.

### 6.6 Cross-Region Processing Complexity

The pipeline spans `af-south-1` and `eu-west-1`.

Observed pattern:

- User-facing auth and ingestion are in South Africa.
- Textract and Bedrock are executed in Ireland.
- Processed outputs return to South Africa.
- DynamoDB is configured in Ireland.

Risks:

- Higher latency.
- Inter-region transfer cost.
- More complicated IAM and troubleshooting.
- Data residency concerns depending on document sensitivity.

### 6.7 OCR Output Loses Document Structure

The Textract completion function concatenates all `LINE` blocks into a single string separated by spaces.

Evidence:

- `textract_completion_lambda.py`

Impact:

- Table structure is lost.
- Spatial context is lost.
- Complex invoices, quotes, or registers may degrade in quality before they even reach Bedrock.

### 6.8 Large Documents Can Be Truncated

The Bedrock prompt includes only the first `MAX_PROMPT_TEXT_LENGTH`, default `12000`, characters of extracted text.

Evidence:

- `bedrock_extraction_lambda.py`

Impact:

- Large documents may be partially processed.
- Important fields near the end of long PDFs may be missed.
- Extraction reliability will drop as document size increases.

### 6.9 Flattened CSV Is Useful for Export but Weak for Analytics

Complex arrays and objects are JSON-stringified and written into a single CSV row.

Evidence:

- `bedrock_extraction_lambda.py`

Impact:

- Fine for one-click export.
- Weak for reporting, search, BI, and downstream normalization.
- Harder to query line items or nested entities.

### 6.10 Customer Identity Mapping Appears Incomplete

The Bedrock extraction Lambda derives `customer_id` from the first path segment of the source key.

Evidence:

- `bedrock_extraction_lambda.py`

If the key is `raw/<filename>`, then the derived customer ID becomes `raw`, which is not a true tenant identifier.

Impact:

- Audit data quality is reduced.
- Multi-customer reporting will be unreliable until the source key includes a customer or tenant partition.

### 6.11 Incomplete Infrastructure Representation

The repo contains `amplify/storage/resource.ts`, but storage is not actually included in `defineBackend`.

Impact:

- The repo mixes managed Amplify definitions with imported external resources.
- Documentation and deployment ownership can become confusing.
- New developers may assume Amplify fully provisions the storage resources when it does not.

## 7. Expanded Error and CloudWatch Guide

The original notes mentioned `403`, `404`, and `500`. Those are relevant, but the actual operational error surface is wider.

### 7.1 `403 AccessDenied`

Meaning:

- The calling principal does not have the right IAM permissions.

Common causes in Syntrix:

- Browser identity lacks bucket read or write access.
- Lambda role cannot read from the temp bucket.
- Lambda role cannot write to the processed bucket.
- Lambda cannot call Textract or Bedrock.

Where to check:

- CloudWatch logs for the failing Lambda.
- IAM role attached to Cognito authenticated users.
- Bucket policy and object path.

### 7.2 `404 NoSuchKey` or Not Found

Meaning:

- The expected S3 object was not found.

Common causes in Syntrix:

- Output path mismatch between frontend expectation and backend write path.
- File deleted before later pipeline stages ran.
- Typo in prefix assumptions such as `raw/`, `processed/`, or `textract/processed/`.

### 7.3 `500 Internal Server Error`

Meaning:

- Unhandled code exception or downstream AWS failure surfaced by the runtime.

Common causes in Syntrix:

- Invalid model response JSON from Bedrock.
- Missing `extractedText`.
- Bad event shape.
- DynamoDB or S3 client failure.

### 7.4 `400 Bad Request`

Common causes:

- Malformed event payload.
- Missing `Records`.
- Missing `JobId`.
- Unsupported or malformed Lambda invocation body.

### 7.5 `429 Too Many Requests` / Throttling

Potential sources:

- Bedrock runtime throttling.
- Textract API throttling.
- S3 request rate pressure during repeated list/poll operations.
- Lambda concurrency limits.

Mitigation:

- Introduce SQS buffering.
- Add exponential backoff.
- Use Step Functions or job-state storage instead of S3 scanning.
- Raise reserved concurrency only after protecting downstream services.

### 7.6 Textract-Specific Failure Modes

Possible issues:

- `FAILED` or `PARTIAL_SUCCESS` job states.
- Missing `DocumentLocation`.
- Very large or poor-quality PDFs producing weak OCR.
- Region mismatch between bucket and Textract service.

### 7.7 Bedrock-Specific Failure Modes

Possible issues:

- Model output is not valid JSON.
- Prompt length exceeded or useful content truncated.
- Regional model availability changes.
- Inference throttling.

### 7.8 DynamoDB Issues

Possible issues:

- Throttling if write volume spikes.
- Item size growth when storing large extracted payloads.
- Weak partition design if customer ID is not real tenant data.

## 8. Scaling Analysis

### 8.1 What Scales Well Already

- S3-based ingestion.
- Lambda-based stateless processing.
- Service separation between OCR and AI extraction.
- Asynchronous workflow direction.

### 8.2 What Will Become a Bottleneck First

- Browser polling and S3 listing.
- Filename-based correlation.
- Cross-region transfers.
- Large-document truncation in Bedrock prompts.
- Flat CSV output for complex records.
- Broad shared buckets in a multi-customer environment.

### 8.3 Recommended Production Scaling Path

Short term:

- Introduce immutable job IDs.
- Partition S3 keys by tenant and job.
- Replace browser direct invoke with API Gateway or a backend service.
- Store job status in DynamoDB instead of discovering outputs through S3 list scans.

Medium term:

- Introduce SQS between stages.
- Add DLQs for each Lambda consumer.
- Add structured error codes and job state transitions.
- Normalize extracted entities into queryable tables or a warehouse.

Long term:

- Move orchestration to Step Functions or a well-defined workflow engine.
- Add event-driven notifications to the UI through WebSocket, SSE, or polling against a job-state API instead of bucket inspection.
- Add a customer-aware tenancy model with isolated prefixes, KMS keys, and scoped IAM policies.

### 8.4 Suggested Production Target Architecture

```text
Browser
  -> API Gateway / App backend
  -> S3 upload with pre-signed URL
  -> Job record in DynamoDB
  -> SQS / Step Functions orchestration
  -> Textract
  -> Bedrock extraction
  -> Normalized storage + export artifact generation
  -> Job status API / notification channel
  -> Browser fetches finished artifact
```

## 9. Network Dependencies and Degradation / Decommissioning Risks

The request mentioned network depreciations. Interpreting that operationally, the biggest network-related concerns are dependency risk, region risk, and future service-change risk.

### 9.1 Cross-Region Network Dependency

The current design moves data between South Africa and Ireland.

Implications:

- Increased latency.
- More failure points.
- Harder debugging when one region is healthy and the other is not.
- Data residency review may be required for regulated customers.

### 9.2 Dependency on Fixed Service Versions and Region Availability

The Bedrock Lambda pins a specific model ID:

- `eu.amazon.nova-2-lite-v1:0`

Implications:

- If model availability changes by region, the pipeline can fail.
- If pricing or token behavior changes, extraction economics change.
- Model deprecation or preferred-version shifts should be reviewed periodically.

### 9.3 Direct Client Access as a Network Surface

Because the browser lists buckets, downloads outputs, uploads files, and invokes Lambda, the client becomes part of the operational network boundary.

Implications:

- More exposed service paths.
- Harder to centralize retries and observability.
- Higher risk of over-permissive IAM in order to keep the client simple.

### 9.4 Resource Mobility Risk

Because buckets and ARNs are hardcoded, the system is brittle when resources are renamed, recreated, or moved.

Implications:

- Migration risk.
- Harder disaster recovery.
- Harder blue/green or multi-environment rollout.

## 10. Comparison With the Live Hosted Syntrix App

### 10.1 Evidence-Based Observations From `syntrixprocure.co.za`

Observed on April 16, 2026:

- The public site is a Cloudflare-fronted single-page app.
- The HTML title is `Go DGTL Solutions - Data Management App`.
- The shipped frontend bundle references a Supabase project URL: `zucpemudpwskxwpznmyu.supabase.co`.
- The shipped route and chunk names indicate a much broader platform than the AWS POC in this repo, including:
  - auth
  - dashboard
  - customers
  - templates
  - datasets
  - workflows
  - data quality
  - admin
  - warehouse
  - gathering export
  - submissions
  - skills processing
  - compliance
  - Syntrix customer, supplier, and agency experiences

Important caution:

- The user described this as the Lovable-hosted app.
- From public headers alone, Lovable was not directly verifiable.
- What is verifiable is that the live app is a Cloudflare-fronted SPA and that its frontend bundle references Supabase.

### 10.2 Functional Positioning Difference

The live hosted app appears to be the broader operational product.

The AWS repository appears to be:

- a narrower document-processing POC
- more infrastructure-centric
- more tightly optimized for OCR plus AI extraction

### 10.3 Trade-Off Matrix

| Dimension | Live hosted app (`syntrixprocure.co.za`) | AWS POC in this repo |
| --- | --- | --- |
| Product breadth | Much broader multi-module platform | Narrow, single workflow portal |
| Speed of feature delivery | Likely faster for CRUD and workflow screens | Slower because infra changes are heavier |
| Data platform style | Appears more app/database-centric | More event-driven document pipeline-centric |
| OCR / document AI specialization | Not directly visible from public bundle | Explicitly built around Textract + Bedrock |
| Operational simplicity | Simpler to iterate if mostly SPA + Supabase | More complex due to IAM, regions, and AWS orchestration |
| Enterprise-scale processing potential | Strong for transactional app features, less obvious for heavy document AI batch | Stronger foundation for batch document automation if hardened |
| Security model | Simpler backend surface if centralized in Supabase | Powerful but easier to misconfigure because of direct AWS service exposure |
| Observability | Usually easier app-level tracing but narrower infra telemetry | Rich CloudWatch-level telemetry if properly instrumented |
| Multi-region complexity | Lower if primarily centralized | Higher because processing already spans multiple regions |
| Vendor lock-in | Supabase and hosted platform lock-in risk | AWS service lock-in risk |

### 10.4 Practical Summary of the Trade-Off

If the goal is:

- rapid business feature delivery, dashboards, customer records, workflows, and operational UI, the live hosted model is probably the faster path
- industrial-strength document ingestion, OCR, AI extraction, governed security, and high-volume batch automation, the AWS direction is the better long-term foundation

The strongest overall strategy may be hybrid:

- keep the broader product UX and operational workflows in the app-centric platform
- offload heavy document AI and batch processing to hardened AWS services

## 11. Recommended Roadmap

### Phase 1: Stabilize the POC

- Replace filename correlation with job IDs.
- Partition S3 keys by tenant and job.
- Remove direct browser Lambda invocation.
- Add explicit status records in DynamoDB.
- Reduce authenticated user bucket permissions to least privilege.

### Phase 2: Improve Reliability

- Add SQS and DLQs.
- Add structured CloudWatch metrics and alarms.
- Add retry policies and idempotency keys.
- Add document validation and antivirus scanning before processing.

### Phase 3: Improve Extraction Quality

- Preserve Textract table and form structure instead of flattening all `LINE` blocks into text.
- Chunk large documents before Bedrock prompting.
- Store normalized outputs in addition to CSV exports.
- Add human review for low-confidence documents.

### Phase 4: Prepare for Scale

- Introduce environment-based configuration instead of hardcoded resources.
- Move to workflow orchestration with Step Functions or an equivalent orchestrator.
- Add tenant isolation, KMS, auditing, and data retention policy enforcement.
- Evaluate whether all processing needs to remain cross-region.

## 12. Specific Code Findings Worth Tracking

These are not blockers for a POC, but they should be treated as action items.

- `src/App.tsx`
  - Upload and output paths rely on raw filenames.
  - Polling strategy depends on repeated S3 list operations.
  - Lambda is invoked directly from the browser.
- `amplify/backend.ts`
  - IAM scope is broad for authenticated users.
  - Imported resources are hardcoded and environment-specific.
- `textract_completion_lambda.py`
  - OCR output collapses lines into plain text, losing layout fidelity.
- `bedrock_extraction_lambda.py`
  - Prompt input is truncated.
  - Nested data is flattened into CSV strings.
  - Customer ID derivation is not tenant-safe.

## 13. Verification Performed

Completed locally on April 16, 2026:

- `npm run lint` succeeded
- `npm run build` succeeded

Note:

- The initial build failed inside the sandbox because `vite` could not spawn `esbuild`.
- Re-running the build outside the sandbox succeeded, which confirms that the failure was environmental, not a code defect.

## 14. Closing Assessment

The Syntrix AWS proof of concept demonstrates that the core automation idea is valid. It can ingest a PDF, run OCR, structure the output with AI, and deliver an exportable artifact with relatively little manual intervention. That is a meaningful result.

However, the current implementation is still a POC from an operational standpoint. To become production-grade, it needs stronger tenant isolation, job tracking, event orchestration, network simplification, and structured data storage.

The live hosted Syntrix application appears to solve a different problem: broader platform usability and business workflow breadth. The AWS version is stronger as a document AI engine. The hosted version appears stronger as a user-facing business platform. Combining those strengths thoughtfully would likely produce the best overall Syntrix architecture.
