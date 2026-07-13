#!/usr/bin/env bash
# Compiles withdraw.circom, runs a Groth16 trusted setup, and exports
# Verifier.sol into ../src/verifiers/. Run on your machine (needs internet for
# circomlib + the powers-of-tau file).
#
# Prereqs:
#   npm i -g snarkjs
#   circom >= 2.1.6 on PATH   (cargo install circom  OR  the release binary)
#   npm i circomlib           (from the repo root; provides include paths)
set -euo pipefail
cd "$(dirname "$0")"

CIRCUIT=transaction
PTAU=powersOfTau28_hez_final_18.ptau   # supports ~262k constraints (join-split is larger); bump if needed
BUILD=build
mkdir -p "$BUILD"

# circomlib include path (installed at repo root)
CIRCOMLIB=../node_modules

echo "==> compiling $CIRCUIT.circom"
circom "$CIRCUIT.circom" --r1cs --wasm --sym -l "$CIRCOMLIB" -o "$BUILD"

if [ ! -f "$BUILD/$PTAU" ]; then
  echo "==> fetching powers of tau ($PTAU)"
  curl -L "https://storage.googleapis.com/zkevm/ptau/$PTAU" -o "$BUILD/$PTAU"
fi

echo "==> groth16 setup"
snarkjs groth16 setup "$BUILD/$CIRCUIT.r1cs" "$BUILD/$PTAU" "$BUILD/${CIRCUIT}_0000.zkey"

echo "==> contributing to phase 2 (dev entropy — DO A REAL CEREMONY FOR PROD)"
snarkjs zkey contribute "$BUILD/${CIRCUIT}_0000.zkey" "$BUILD/${CIRCUIT}_final.zkey" \
  --name="dev" -v -e="$(head -c 64 /dev/urandom | xxd -p -c 64)"

snarkjs zkey export verificationkey "$BUILD/${CIRCUIT}_final.zkey" "$BUILD/verification_key.json"

echo "==> exporting Verifier.sol"
snarkjs zkey export solidityverifier "$BUILD/${CIRCUIT}_final.zkey" ../src/verifiers/Verifier.sol
# snarkjs names the contract "Groth16Verifier" and function "verifyProof" with
# the correct [5] public-input arity — matches IVerifier. Give it the SPDX +
# pragma your repo expects if forge complains.

echo "==> done. Verifier.sol written to src/verifiers/Verifier.sol"
