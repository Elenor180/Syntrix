import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { orchestratorFunction } from './functions/orchestrator/resource'; //
import { Bucket } from 'aws-cdk-lib/aws-s3'; 
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';

const backend = defineBackend({
  auth,
  orchestratorFunction, // Let Amplify manage the deployment of your code
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

// Allow the authenticated users to invoke the NEW Amplify-managed Orchestrator
backend.orchestratorFunction.resources.lambda.grantInvoke(backend.auth.resources.authenticatedUserIamRole);

// 3. CLEAN OUTPUTS
backend.addOutput({
  storage: {
    aws_region: 'af-south-1',
    bucket_name: ingestionBucket.bucketName,
  },
  custom: {
    // This now dynamically points to the new function URL
    orchestratorFunctionArn: backend.orchestratorFunction.resources.lambda.functionArn,
    processedBucketName: processedBucket.bucketName,
    tempBucketName: 'processing-temp-613272079074-eu-west-1'
  },
});