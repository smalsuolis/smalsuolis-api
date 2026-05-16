// mTLS client materials for the Lithuanian jump proxy. Present in prod, absent
// in local dev (where upstreams are reachable directly from LT). The cert
// materials are shared across any integration that needs to go through the
// jump — the per-integration thing is only the URL mapping.
export function buildJumpHttpsOpt() {
  const cert = process.env.LT_JUMP_CLIENT_CERT_B64;
  const key = process.env.LT_JUMP_CLIENT_KEY_B64;
  const ca = process.env.LT_JUMP_CA_B64;
  if (!cert || !key || !ca) return {};
  return {
    https: {
      certificate: Buffer.from(cert, 'base64').toString('utf-8'),
      key: Buffer.from(key, 'base64').toString('utf-8'),
      certificateAuthority: Buffer.from(ca, 'base64').toString('utf-8'),
    },
  };
}
