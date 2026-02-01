import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { Bucket } from 'aws-cdk-lib/aws-s3'; 
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';

const backend = defineBackend({
  auth,
  // Removed orchestratorFunction reference to stop the "Module Not Found" error
});

// 1. STACK MAPPING (Existing S3 Buckets)
const ingestionStack = backend.createStack('IngestionStack');
const ingestionBucket = Bucket.fromBucketAttributes(ingestionStack, 'ImportedIngestionBucket', {
  bucketArn: 'arn:aws:s3:::syntrix-doc-ingestion',
  region: 'af-south-1' 
});

const processedStack = backend.createStack('ProcessedStack');
const processedBucket = Bucket.fromBucketAttributes(processedStack, 'ImportedProcessedBucket', {
  bucketArn: 'arn:aws:s3:::syntrix-doc-processed',
  region: 'af-south-1' 
});

// 2. PERMISSION SYNC
backend.auth.resources.authenticatedUserIamRole.addToPrincipalPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      's3:PutObject', 
      's3:GetObject', 
      's3:ListBucket', 
      's3:DeleteObject',
      's3:GetBucketLocation'
    ],
    resources: [
      ingestionBucket.bucketArn,
      `${ingestionBucket.bucketArn}/*`,
      processedBucket.bucketArn,
      `${processedBucket.bucketArn}/*`
    ],
  })
);

// Allow users to invoke the EXISTING manual Orchestrator in your account
backend.auth.resources.authenticatedUserIamRole.addToPrincipalPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['lambda:InvokeFunction'],
    resources: ['arn:aws:lambda:af-south-1:613272079074:function:SyntrixPOCRegionA-OrchestratorFunction-xcTHWjvQTL3t'],
  })
);

// 3. CLEAN OUTPUTS
backend.addOutput({
  storage: {
    aws_region: 'af-south-1',
    bucket_name: ingestionBucket.bucketName,
  },
  custom: {
    // Hardcoded ARN to ensure the frontend connects to your existing logic
    orchestratorFunctionArn: 'arn:aws:lambda:af-south-1:613272079074:function:SyntrixPOCRegionA-OrchestratorFunction-xcTHWjvQTL3t',
    processedBucketName: processedBucket.bucketName,
    tempBucketName: 'processing-temp-613272079074-eu-west-1'
  },
});