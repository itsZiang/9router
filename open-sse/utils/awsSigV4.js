import { createHash, createHmac } from "node:crypto";
function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}
function hmacHex(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}
function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function canonicalUri(pathname) {
  const path = pathname || "/";
  return path.split("/").map(segment => awsEncode(decodeURIComponent(segment))).join("/");
}
function canonicalQuery(searchParams) {
  return [...searchParams.entries()].sort(([keyA, valueA], [keyB, valueB]) => keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB)).map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`).join("&");
}
function amzDateParts(now) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8)
  };
}
function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    normalized[key.toLowerCase()] = String(value).trim().replace(/\s+/g, " ");
  }
  return normalized;
}
function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}
export function signAwsRequest({
  method,
  url,
  region,
  service,
  headers = {},
  body = "",
  credentials,
  now = new Date()
}) {
  const parsedUrl = new URL(url);
  const payload = body ?? "";
  const payloadHash = sha256Hex(payload);
  const {
    amzDate,
    dateStamp
  } = amzDateParts(now);
  const canonicalHeadersMap = normalizeHeaders({
    ...headers,
    host: parsedUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken ? {
      "x-amz-security-token": credentials.sessionToken
    } : {})
  });
  const signedHeaderNames = Object.keys(canonicalHeadersMap).sort();
  const canonicalHeaders = signedHeaderNames.map(name => `${name}:${canonicalHeadersMap[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [method.toUpperCase(), canonicalUri(parsedUrl.pathname), canonicalQuery(parsedUrl.searchParams), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(credentials.secretAccessKey, dateStamp, region, service), stringToSign);
  return {
    ...canonicalHeadersMap,
    Authorization: ["AWS4-HMAC-SHA256", `Credential=${credentials.accessKeyId}/${credentialScope},`, `SignedHeaders=${signedHeaders},`, `Signature=${signature}`].join(" ")
  };
}