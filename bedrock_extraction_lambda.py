import csv
import io
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from urllib.parse import unquote_plus

import boto3


# Stage 0: Configure logging, runtime settings, and AWS clients.
LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

INPUT_REGION = os.getenv("INPUT_REGION", "eu-west-1")
OUTPUT_REGION = os.getenv("OUTPUT_REGION", "af-south-1")
BEDROCK_REGION = os.getenv("BEDROCK_REGION", "eu-west-1")
DYNAMODB_REGION = os.getenv("DYNAMODB_REGION", "eu-west-1")

INPUT_BUCKET = os.getenv("INPUT_BUCKET", "processing-temp-613272079074-eu-west-1")
OUTPUT_BUCKET = os.getenv("OUTPUT_BUCKET", "syntrix-doc-processed")
MODEL_ID = os.getenv("MODEL_ID", "eu.amazon.nova-2-lite-v1:0")
DYNAMODB_TABLE = os.getenv("DYNAMODB_TABLE", "DocumentProcessing")

TEXTRACT_INPUT_PREFIX = "textract/processed/"
PROCESSED_OUTPUT_PREFIX = "processed/"
METADATA_OUTPUT_PREFIX = "extracted"
MAX_PROMPT_TEXT_LENGTH = int(os.getenv("MAX_PROMPT_TEXT_LENGTH", "12000"))
MODEL_MAX_TOKENS = int(os.getenv("MODEL_MAX_TOKENS", "2048"))

s3_read = boto3.client("s3", region_name=INPUT_REGION)
s3_write = boto3.client("s3", region_name=OUTPUT_REGION)
bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
dynamodb = boto3.resource("dynamodb", region_name=DYNAMODB_REGION)
table = dynamodb.Table(DYNAMODB_TABLE)


def convert_to_dynamodb_format(obj):
    """Convert floats to Decimal for DynamoDB compatibility."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {key: convert_to_dynamodb_format(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [convert_to_dynamodb_format(item) for item in obj]
    return obj


def _read_s3_json(bucket: str, key: str) -> dict:
    """Read a JSON object from S3 and return it as a dictionary."""
    response = s3_read.get_object(Bucket=bucket, Key=key)
    return json.loads(response["Body"].read())


def _write_s3_csv(bucket: str, key: str, data: dict):
    """Write a single-row CSV object to S3."""
    output = io.StringIO(newline="")
    writer = csv.writer(output)

    headers = list(data.keys())
    writer.writerow(headers)

    values = []
    for field in headers:
        value = data[field]
        if isinstance(value, (list, dict)):
            value = json.dumps(value, ensure_ascii=False)
        values.append(value)
    writer.writerow(values)

    s3_write.put_object(
        Bucket=bucket,
        Key=key,
        Body=output.getvalue().encode("utf-8"),
        ContentType="text/csv",
    )


def _write_s3_json(bucket: str, key: str, data: dict):
    """Write a JSON object to S3."""
    s3_write.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json",
    )


def _extract_s3_from_event(event: dict):
    """
    Return a list of (bucket, key) pairs from supported event shapes.

    Supported inputs:
      - Direct S3 event
      - SQS event carrying an embedded S3 event
      - SQS event carrying a simple {bucket, key} payload
    """
    results = []

    for record in event.get("Records", []):
        event_source = record.get("eventSource")

        # Stage 1A: Handle direct S3 notifications.
        if event_source in ("aws:s3", "aws:s3.amazonaws.com"):
            bucket = record["s3"]["bucket"]["name"]
            key = unquote_plus(record["s3"]["object"]["key"])
            results.append((bucket, key))
            continue

        # Stage 1B: Handle SQS notifications that wrap S3 references.
        if event_source != "aws:sqs":
            continue

        body = record.get("body")
        if not body:
            continue

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            LOGGER.warning("Skipping SQS message with non-JSON body.")
            continue

        if "Records" in payload:
            for nested_record in payload["Records"]:
                if nested_record.get("eventSource") not in ("aws:s3", "aws:s3.amazonaws.com"):
                    continue
                bucket = nested_record["s3"]["bucket"]["name"]
                key = unquote_plus(nested_record["s3"]["object"]["key"])
                results.append((bucket, key))
            continue

        if "bucket" in payload and "key" in payload:
            results.append((payload["bucket"], payload["key"]))

    return results


def _build_nova_body(text: str, file_name: str) -> dict:
    """Build a Bedrock Converse request for Nova extraction."""
    instructions = (
        "You are a document extraction assistant for a BEE and procurement system.\n\n"
        "STEP 1: Identify the document type from this list:\n"
        "- invoice: Payment invoices\n"
        "- contract: Procurement contracts or agreements\n"
        "- quote: Quotations or RFQ responses\n"
        "- purchase_order: Purchase orders\n"
        "- bee_certificate: BEE verification certificates\n"
        "- tax_clearance: SARS tax clearance certificates\n"
        "- register: Learnership attendance registers\n"
        "- other: Any other document type\n\n"
        "STEP 2: Extract relevant fields based on document type:\n\n"
        "For invoice: vendor, invoice_number, date, line_items (array of {description, quantity, unit_price}), total_amount, currency\n"
        "For contract: parties (array), effective_date, expiration_date, contract_value, key_terms (array)\n"
        "For quote: supplier_name, quote_number, date, validity_period, line_items (array), total_amount, currency, terms\n"
        "For purchase_order: po_number, supplier, date, delivery_date, line_items (array), total_amount, currency\n"
        "For bee_certificate: supplier_name, site_location, vendor_no, reg_no, vat_no, expenditure_including_vat, expenditure_excluding_vat, supplier_classification, bee_level, black_owned_51_percent_or_more, black_ownership_percentage, black_woman_owned_30_percent_or_more, black_woman_ownership_percentage, esd_recipient_black_owned_qse_eme, designated_group_supplier, first_time_supplier, bee_certificate_expiry_date\n"
        "For tax_clearance: company_name, tax_number, issue_date, expiry_date, status, reference_number\n"
        "For register: program_name, date, attendees (array of {name, surname, time_in, time_out}), total_attendees\n"
        "For other: summary, key_points (array)\n\n"
        "Return ONLY valid JSON in this exact schema (no extra text):\n"
        "{\n"
        '  "document_type": "<type>",\n'
        '  "extracted_data": { <fields based on type> },\n'
        '  "summary": "<brief summary>"\n'
        "}\n\n"
        f"File: {file_name}\n"
        f"Document text:\n{text[:MAX_PROMPT_TEXT_LENGTH]}"
    )

    return {
        "messages": [
            {
                "role": "user",
                "content": [{"text": instructions}],
            }
        ],
        "inferenceConfig": {
            "temperature": 0,
            "maxTokens": MODEL_MAX_TOKENS,
        },
    }


def _invoke_nova(model_id: str, body: dict) -> str:
    """Invoke the Bedrock Converse API and return the text response."""
    response = bedrock.converse(
        modelId=model_id,
        messages=body["messages"],
        inferenceConfig=body["inferenceConfig"],
    )

    content = response.get("output", {}).get("message", {}).get("content", [])
    if not content:
        return ""

    return content[0].get("text", "").strip()


def _parse_model_json(text: str) -> dict:
    """
    Parse JSON from the model response.

    Stage order:
      1. Parse the entire response directly.
      2. Fall back to the first top-level JSON object in the text.
    """
    if not text:
        return {}

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            snippet = text[start : end + 1]
            try:
                return json.loads(snippet)
            except json.JSONDecodeError:
                pass

    return {"raw_output": text}


def _derive_paths(input_key: str, payload: dict):
    """
    Derive source and output paths from the Textract JSON key.

    Expected input key:
      textract/processed/raw/<original-file>.json

    Resulting frontend CSV key:
      processed/raw/<original-file>.csv
    """
    if input_key.startswith(TEXTRACT_INPUT_PREFIX):
        source_file_key = input_key[len(TEXTRACT_INPUT_PREFIX) :]
    else:
        source_file_key = input_key

    if source_file_key.endswith(".json"):
        source_file_key = source_file_key[:-5]

    file_name = payload.get("file_name") or os.path.basename(source_file_key) or "unknown"
    output_csv_key = f"{PROCESSED_OUTPUT_PREFIX}{source_file_key}.csv"
    return source_file_key, file_name, output_csv_key


def _build_csv_row(document_id: str, file_name: str, document_type: str, summary: str, extracted_data: dict):
    """Build the flat CSV row written to the processed bucket."""
    csv_data = {
        "document_id": document_id,
        "file_name": file_name,
        "document_type": document_type,
        "summary": summary,
    }
    csv_data.update(extracted_data)
    return csv_data


def _build_metadata(document_id: str, file_name: str, document_type: str, source_bucket: str, source_key: str, model_text: str, parsed_output: dict):
    """Build the metadata payload stored for auditability."""
    return {
        "document_id": document_id,
        "file_name": file_name,
        "document_type": document_type,
        "source_bucket": source_bucket,
        "source_key": source_key,
        "model_id": MODEL_ID,
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "model_response_text": model_text,
        "parsed_model_output": parsed_output,
    }


def _process_record(bucket: str, key: str) -> dict:
    """Process a single Textract JSON object through the Bedrock extraction flow."""
    parts = key.split("/")
    document_id = str(uuid.uuid4())

    # Stage 2: Read and validate the Textract JSON payload from the input bucket.
    payload = _read_s3_json(bucket, key)
    source_file_key, file_name, output_csv_key = _derive_paths(key, payload)
    text = payload.get("extractedText", "")

    if not isinstance(text, str) or not text.strip():
        raise ValueError(f"Invalid or missing 'extractedText' field in {key}")

    # Stage 3: Build the Nova prompt and invoke Bedrock for document extraction.
    request_body = _build_nova_body(text, file_name)
    model_text = _invoke_nova(MODEL_ID, request_body)
    parsed = _parse_model_json(model_text)

    if "raw_output" in parsed:
        raise ValueError(f"Model did not return valid JSON for {key}")

    document_type = str(parsed.get("document_type") or "other").lower()
    extracted_data = parsed.get("extracted_data", {})
    summary = parsed.get("summary", "")

    if not isinstance(extracted_data, dict):
        raise ValueError(f"Invalid 'extracted_data' structure returned for {key}")

    if not isinstance(summary, str):
        summary = str(summary)

    # Stage 4: Persist the frontend-ready CSV artifact to the processed bucket.
    csv_row = _build_csv_row(document_id, file_name, document_type, summary, extracted_data)
    _write_s3_csv(OUTPUT_BUCKET, output_csv_key, csv_row)
    LOGGER.info("Saved CSV output to s3://%s/%s", OUTPUT_BUCKET, output_csv_key)

    # Stage 5: Persist the processing record to DynamoDB using the current item mapping.
    customer_id = parts[0] if len(parts) > 1 else "unknown"
    processed_date = datetime.now(timezone.utc).isoformat()

    table.put_item(
        Item={
            "DocumentID": document_id,
            "CustomerID": customer_id,
            "DocumentType": document_type,
            "FileName": file_name,
            "ProcessedDate": processed_date,
            "Status": "processed",
            "ExtractedData": convert_to_dynamodb_format(extracted_data),
            "Summary": summary,
            "S3Location": f"s3://{OUTPUT_BUCKET}/{output_csv_key}",
        }
    )
    LOGGER.info("Saved DynamoDB record for DocumentID=%s, CustomerID=%s", document_id, customer_id)

    # Stage 6: Persist metadata for traceability and model-output auditability.
    metadata_key = f"{METADATA_OUTPUT_PREFIX}/{document_type}/{document_id}/metadata.json"
    metadata = _build_metadata(document_id, file_name, document_type, bucket, key, model_text, parsed)
    _write_s3_json(OUTPUT_BUCKET, metadata_key, metadata)

    return {
        "in": f"s3://{bucket}/{key}",
        "out": f"s3://{OUTPUT_BUCKET}/{output_csv_key}",
        "document_type": document_type,
        "document_id": document_id,
    }


def lambda_handler(event, context):
    """Entry point for Bedrock extraction processing."""
    LOGGER.info("Received event preview: %s", json.dumps(event)[:1500])

    # Stage 1: Resolve input S3 references from the triggering event.
    s3_refs = _extract_s3_from_event(event)
    if not s3_refs:
        return {"status": "no_s3_records"}

    results = []
    for bucket, key in s3_refs:
        if bucket != INPUT_BUCKET:
            LOGGER.warning("Processing object from bucket %s; configured input bucket is %s", bucket, INPUT_BUCKET)
        try:
            result = _process_record(bucket, key)
            results.append(
                {
                    "in": result["in"],
                    "out": result["out"],
                    "document_type": result["document_type"],
                }
            )
        except Exception as exc:
            error_doc_id = key.replace("/", "_") if key else "unknown"
            error_key = f"{METADATA_OUTPUT_PREFIX}/errors/{error_doc_id}/error.json"
            error_payload = {
                "error": str(exc),
                "source_key": key,
                "bucket": bucket,
                "processed_at": datetime.now(timezone.utc).isoformat(),
            }

            try:
                # Stage 7: Persist an error artifact when record processing fails.
                _write_s3_json(OUTPUT_BUCKET, error_key, error_payload)
            except Exception as write_error:
                LOGGER.exception("Failed to write error object for %s: %s", key, write_error)

            LOGGER.exception("Error processing %s", key)
            results.append(
                {
                    "in": f"s3://{bucket}/{key}",
                    "error": str(exc),
                }
            )

    return {"status": "ok", "processed": len(results), "results": results}
