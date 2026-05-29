import json
import logging
import os
from datetime import datetime, timezone

import boto3


# Stage 0: Configure logging, runtime settings, and AWS clients.
LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

TEXTRACT_REGION = os.getenv("TEXTRACT_REGION", "eu-west-1")
TEMP_BUCKET = os.getenv("TEMP_BUCKET", "processing-temp-613272079074-eu-west-1")
TEXTRACT_OUTPUT_PREFIX = os.getenv("TEXTRACT_OUTPUT_PREFIX", "textract/processed/")

textract_client = boto3.client("textract", region_name=TEXTRACT_REGION)
s3_eu_west = boto3.client("s3", region_name=TEXTRACT_REGION)


def _extract_source_key(sns_message: dict) -> str | None:
    """Resolve the original source object key from the Textract SNS payload."""
    document_location = sns_message.get("DocumentLocation", {})
    return document_location.get("S3ObjectName") or document_location.get("S3Object", {}).get("Name")


def _collect_textract_results(job_id: str) -> list[dict]:
    """Fetch all available Textract result pages for a completed analysis job."""
    responses = []
    next_token = None

    while True:
        params = {"JobId": job_id}
        if next_token:
            params["NextToken"] = next_token

        response = textract_client.get_document_analysis(**params)
        responses.append(response)

        next_token = response.get("NextToken")
        if not next_token:
            break

    return responses


def process_textract_results(responses: list[dict], job_id: str, source_key: str) -> dict:
    """Build the Bedrock-ready JSON payload from Textract analysis responses."""
    blocks = []
    document_metadata = {}

    for response in responses:
        blocks.extend(response.get("Blocks", []))
        if not document_metadata:
            document_metadata = response.get("DocumentMetadata", {})

    text_blocks = [block for block in blocks if block.get("BlockType") == "LINE"]
    extracted_text = " ".join(block.get("Text", "") for block in text_blocks).strip()

    return {
        "jobId": job_id,
        "file_name": os.path.basename(source_key),
        "sourceKey": source_key,
        "documentMetadata": document_metadata,
        "extractedText": extracted_text,
        "totalBlocks": len(blocks),
        "textLines": len(text_blocks),
        "processedAt": datetime.now(timezone.utc).isoformat(),
        "syntrix_status": "success",
    }


def handler(event, context):
    """Handle Textract completion events and persist Bedrock input JSON to S3."""
    LOGGER.info("Received SNS event preview: %s", json.dumps(event)[:1500])

    if "Records" not in event:
        return {"statusCode": 400, "body": json.dumps({"error": "No Records found in event"})}

    results = []

    for record in event["Records"]:
        job_id = None

        try:
            # Stage 1: Parse the SNS completion message and validate the Textract job state.
            sns_message = json.loads(record["Sns"]["Message"])
            job_id = sns_message.get("JobId")
            status = sns_message.get("Status")

            LOGGER.info("Processing Textract job %s with status %s", job_id, status)

            if not job_id:
                raise ValueError("Missing JobId in SNS message")

            if status != "SUCCEEDED":
                LOGGER.warning("Skipping Textract job %s because status is %s", job_id, status)
                results.append({"jobId": job_id, "status": status})
                continue

            source_key = _extract_source_key(sns_message)
            if not source_key:
                raise ValueError("Missing source object key in SNS message")

            # Stage 2: Retrieve the Textract analysis output from the completed job.
            responses = _collect_textract_results(job_id)

            # Stage 3: Transform Textract results into the JSON payload used by Bedrock.
            extracted_data = process_textract_results(responses, job_id, source_key)

            # Stage 4: Persist the Bedrock input JSON to the EU temporary bucket.
            json_key = f"{TEXTRACT_OUTPUT_PREFIX}{source_key}.json"
            s3_eu_west.put_object(
                Bucket=TEMP_BUCKET,
                Key=json_key,
                Body=json.dumps(extracted_data, ensure_ascii=False, indent=2).encode("utf-8"),
                ContentType="application/json",
            )
            LOGGER.info("Saved Bedrock input JSON to s3://%s/%s", TEMP_BUCKET, json_key)

            # Stage 5: Remove the copied source document from the temporary bucket after JSON creation.
            try:
                s3_eu_west.delete_object(Bucket=TEMP_BUCKET, Key=source_key)
                LOGGER.info("Deleted temporary source object s3://%s/%s", TEMP_BUCKET, source_key)
            except Exception as cleanup_error:
                LOGGER.warning("Temporary object cleanup failed for %s: %s", source_key, cleanup_error)

            results.append(
                {
                    "jobId": job_id,
                    "status": "processed",
                    "output": f"s3://{TEMP_BUCKET}/{json_key}",
                }
            )

        except Exception as exc:
            LOGGER.exception("Error processing Textract completion record")
            results.append(
                {
                    "jobId": job_id,
                    "status": "error",
                    "error": str(exc),
                }
            )

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "Textract completion processing finished.",
                "results": results,
            }
        ),
    }
