#!/usr/bin/env bash
# Harness-only self-signed CA + PostgreSQL server certificate (CN/SAN =
# `postgres`, the compose service name, so verify-full hostname checking is
# genuinely exercised). Output goes to certs/generated (gitignored). Never a
# production trust anchor — production trusts the AWS RDS global bundle.
set -euo pipefail
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/generated"
mkdir -p "$OUT"
cd "$OUT"
if [[ -f ca.pem && -f server.pem && -f server.key ]]; then
  echo "harness certificates already present in $OUT"
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 -subj "/CN=Himma Harness CA" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=postgres" >/dev/null 2>&1
printf 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1\n' > san.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 30 -extfile san.cnf >/dev/null 2>&1
# postgres (uid 999 in the official image) must be able to read the key.
chmod 0644 ca.pem server.pem
chmod 0600 server.key
chown 999:999 server.key 2>/dev/null || true
rm -f server.csr san.cnf ca.srl
echo "harness certificates generated in $OUT"
