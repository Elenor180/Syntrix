import { referenceAuth } from '@aws-amplify/backend';

export const auth = referenceAuth({
  userPoolId: 'af-south-1_NSJDuDgfq',
  identityPoolId: 'af-south-1:66accfee-01bb-4ade-a157-a7917e8da298',
  userPoolClientId: '587ovbh6hp1i26m9u1sen8unjd',
  authRoleArn: 'arn:aws:iam::613272079074:role/service-role/syntrix-auth',
  
  // Mandatory ARN
  unauthRoleArn: 'arn:aws:iam::613272079074:role/service-role/Cognito_syntrix_IdentityPool_Unauth_Role'
});