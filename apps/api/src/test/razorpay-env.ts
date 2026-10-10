// Imported first by the Razorpay test file so the API starts with the Razorpay adapter.
// The values are made up; no request leaves the machine (fetch is replaced by a fake).
import './env';

process.env.PAYMENT_PROVIDER = 'razorpay';
process.env.PAYMENT_API_KEY = 'rzp_test_ServeosUnitTests';
process.env.PAYMENT_API_SECRET = 'unit-test-key-secret-0123456789';
process.env.PAYMENT_WEBHOOK_SECRET = 'unit-test-webhook-secret-0123456789';
