import { expect, test } from "vitest";
import { isSensitivePath, redactSecrets } from "../src/core/secrets";

test.each([
  ".env",
  "config/.env.production",
  "id_rsa",
  "certs/server.pem",
  ".ssh/config",
  "secrets.yaml",
  "prod.tfvars",
])("marks %s as sensitive", (path) => {
  expect(isSensitivePath(path)).toBe(true);
});

test.each(["src/env.ts", ".env.example", "README.md", "keys.ts"])("does not mark %s as sensitive", (path) => {
  expect(isSensitivePath(path)).toBe(false);
});

test("supports extra sensitive names", () => {
  expect(isSensitivePath("config/vault-token.txt", ["vault"])).toBe(true);
});

test("redacts common secret formats", () => {
  const github = `ghp_${"a".repeat(36)}`;
  const input = [
    "AWS=AKIAABCDEFGHIJKLMNOP",
    `token ${github}`,
    'password = "hunter2hunter2"',
    "url=https://user:pa55word@example.com/db",
    "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const { text, found } = redactSecrets(input);
  expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
  expect(text).not.toContain(github);
  expect(text).not.toContain("hunter2hunter2");
  expect(text).not.toContain("pa55word");
  expect(text).not.toContain("abc\n");
  expect(text).toContain('password = "[REDACTED]"');
  expect(found).toEqual(expect.arrayContaining(["AWS access key", "GitHub token", "private key"]));
});

test("redacts unquoted values in env and YAML files", () => {
  const { text } = redactSecrets(
    "DB_PASSWORD=s3cretValue1\nexport API_TOKEN=abcdefgh12\napi_key: zyxwvuts987\nname: app",
  );
  expect(text).toBe("DB_PASSWORD=[REDACTED]\nexport API_TOKEN=[REDACTED]\napi_key: [REDACTED]\nname: app");
});

test("keeps ordinary code unchanged", () => {
  const code =
    "const token = getToken();\nif (password.length < 8) return;\nconst secretName = apiKeySecretName(url);\npassword: user.password,";
  expect(redactSecrets(code).text).toBe(code);
});
