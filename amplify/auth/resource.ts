import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: {
      // Enables email + password sign-in
      // You can leave this empty for default Cognito behavior
    }
  }
});