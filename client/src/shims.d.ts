// Untyped deps used by the SDK. circomlibjs/snarkjs ship no types; we use narrow
// runtime surfaces of both and validate behaviour in the offline + e2e tests.
declare module "circomlibjs";
declare module "snarkjs";
