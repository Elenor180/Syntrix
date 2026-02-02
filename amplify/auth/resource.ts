import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: {
      // This enables email login
      // You can leave this empty/object for default behavior
    }
  },

  // Allow users to sign up themselves
  userSignup: {
    selfSignUp: true
  }
});