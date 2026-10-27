import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  compilePatterns,
  redactSecrets,
  sanitizeText,
  stripPrivateTags,
  truncate,
  type CompiledPrivacyPattern,
} from "../src/privacy.ts";

function defaults(): CompiledPrivacyPattern[] {
  return compilePatterns(DEFAULT_CONFIG.privacyPatterns);
}

function sanitize(text: string, maxTextLength = DEFAULT_CONFIG.maxTextLength) {
  return sanitizeText(text, { patterns: defaults(), maxTextLength });
}

describe("stripPrivateTags", () => {
  it("removes a <private> block from tool output text", () => {
    const output = "build ok\n<private>internal host 10.0.0.5 / db creds</private>\ndone";
    const result = stripPrivateTags(output);
    expect(result).not.toContain("internal host");
    expect(result).not.toContain("10.0.0.5");
    expect(result).not.toContain("<private>");
    expect(result).not.toContain("</private>");
    expect(result).toContain("build ok");
    expect(result).toContain("done");
  });

  it("removes a <private> block from tool input text (JSON args)", () => {
    const input = JSON.stringify({
      text: "Remember: staging uses <private>password hunter2</private> rotation weekly",
    });
    const result = stripPrivateTags(input);
    expect(result).not.toContain("hunter2");
    expect(result).toContain("rotation weekly");
  });

  it("removes a <private> block from prompt text (serialized conversation)", () => {
    const prompt =
      "[User]: my phone is <private>+7 999 123-45-67</private>, deploy at 5pm\n\n[Assistant]: ok";
    const result = stripPrivateTags(prompt);
    expect(result).not.toContain("999 123-45-67");
    expect(result).toContain("deploy at 5pm");
    expect(result).toContain("[Assistant]: ok");
  });

  it("removes multiple and multiline blocks", () => {
    const text = "a <private>one</private> b <private>\nline1\nline2\n</private> c";
    const result = stripPrivateTags(text);
    expect(result).not.toMatch(/one|line1|line2/);
    expect(result).toMatch(/a[\s\S]*b[\s\S]*c/);
  });

  it("is case-insensitive for tag names", () => {
    const result = stripPrivateTags("x <PRIVATE>secret-stuff</Private> y");
    expect(result).not.toContain("secret-stuff");
    expect(result).toContain("x");
    expect(result).toContain("y");
  });

  it("fails closed on an unclosed <private> tag: everything after it is removed", () => {
    const result = stripPrivateTags("public part <private>never closed secret tail");
    expect(result).toContain("public part");
    expect(result).not.toContain("never closed");
    expect(result).not.toContain("secret tail");
  });

  it("leaves text without tags unchanged", () => {
    expect(stripPrivateTags("plain text, nothing hidden")).toBe("plain text, nothing hidden");
  });
});

describe("default privacy patterns (TZ sections 3.4 and 5)", () => {
  const cases: Array<{ name: string; text: string; secret: string; keep?: string }> = [
    {
      name: "AWS access key id (AKIA...)",
      text: "aws key AKIAIOSFODNN7EXAMPLE used in ci",
      secret: "AKIAIOSFODNN7EXAMPLE",
      keep: "used in ci",
    },
    {
      name: "Bearer token",
      text: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_-value' https://api",
      secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_-value",
      keep: "https://api",
    },
    {
      name: "PRIVATE KEY block (header and body)",
      text: [
        "key below:",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
        "-----END RSA PRIVATE KEY-----",
        "end of note",
      ].join("\n"),
      secret: "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      keep: "end of note",
    },
    {
      name: "OPENSSH PRIVATE KEY header",
      text: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----",
      secret: "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
    },
    {
      name: "API_KEY= env line",
      text: "API_KEY=abcd1234supersecret\nOTHER=1",
      secret: "abcd1234supersecret",
    },
    {
      name: "bare KEY= env line (no api_ prefix)",
      text: "KEY=plain-secret-value\nOTHER=1",
      secret: "plain-secret-value",
      keep: "OTHER=1",
    },
    {
      name: "SSH_KEY= env line",
      text: "SSH_KEY=plain-secret-value",
      secret: "plain-secret-value",
    },
    {
      name: "lowercase private-key: value",
      text: "private-key: plain-secret-value done",
      secret: "plain-secret-value",
      keep: "done",
    },
    {
      name: "double-quoted value with spaces and escaped quotes",
      text: 'PASSWORD="two \\"words\\" secret" tail',
      secret: "words",
      keep: "tail",
    },
    {
      name: "TOKEN= env line",
      text: "GITHUB_TOKEN=tok_9f8e7d6c5b4a",
      secret: "tok_9f8e7d6c5b4a",
    },
    {
      name: "PASSWORD= env line",
      text: "DB_PASSWORD=hunter2hunter2",
      secret: "hunter2hunter2",
    },
    {
      name: "SECRET= env line",
      text: "CLIENT_SECRET=s3cr3tValue42",
      secret: "s3cr3tValue42",
    },
    {
      name: "AWS_SECRET_ACCESS_KEY= env line",
      text: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    {
      name: "lowercase 'password: value' (case-insensitive (?i) pattern)",
      text: "the admin password: Tr0ub4dor&3 was rotated",
      secret: "Tr0ub4dor&3",
      keep: "was rotated",
    },
    {
      name: "GitHub token prefix ghp_",
      text: "use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the bot",
      secret: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      keep: "for the bot",
    },
    {
      name: "OpenAI-like token prefix sk-",
      text: "OPENAI key is sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 ok",
      secret: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    },
    {
      // Built from fragments (not a single literal) so the fake fixture never
      // appears as one contiguous string in source/history and does not trip
      // GitHub push-protection secret scanning for real GitLab tokens.
      name: "GitLab token prefix glpat-",
      text: `runner uses glpat-${"xY9zA8"}${"bC7dE6fG5hI4jK"} now`,
      secret: `glpat-${"xY9zA8"}${"bC7dE6fG5hI4jK"}`,
      keep: "now",
    },
  ];

  for (const c of cases) {
    it(`redacts: ${c.name}`, () => {
      const result = sanitize(c.text);
      expect(result.text).not.toContain(c.secret);
      expect(result.text).toMatch(/\[REDACTED:[^\]]+\]/);
      expect(result.redacted).toBe(true);
      expect(result.matchedPatterns.length).toBeGreaterThan(0);
      if (c.keep) expect(result.text).toContain(c.keep);
    });
  }

  it("does not redact ordinary prose", () => {
    const text = "We decided to use the token bucket algorithm; the secret sauce is caching.";
    const result = sanitize(text);
    expect(result.text).toBe(text);
    expect(result.redacted).toBe(false);
    expect(result.matchedPatterns).toEqual([]);
  });

  it("gives the same result when the compiled patterns are reused (no RegExp lastIndex state leak)", () => {
    const patterns = defaults();
    const text = "k1 AKIAIOSFODNN7EXAMPLE k2 AKIAIOSFODNN7EXAMPLE";
    const a = redactSecrets(text, patterns);
    const b = redactSecrets(text, patterns);
    expect(a).toEqual(b);
    expect(a.text).not.toContain("AKIA");
  });

  it("redacts all occurrences, not only the first one", () => {
    const result = sanitize("first AKIAIOSFODNN7EXAMPLE second AKIAABCDEFGHIJKLMNOP");
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });
});

describe("compilePatterns (extensible list from config)", () => {
  it("translates a leading (?i) into a case-insensitive regex", () => {
    const [p] = compilePatterns(["(?i)topsecret"]);
    expect(p.regex.flags).toContain("i");
    expect(redactSecrets("TopSecret here", [p]).redacted).toBe(true);
  });

  it("supports named custom patterns and uses the name in the marker", () => {
    const patterns = compilePatterns([{ name: "internal-id", pattern: "INT-[0-9]{4}" }]);
    const result = redactSecrets("ticket INT-1234 closed", patterns);
    expect(result.text).toBe("ticket [REDACTED:internal-id] closed");
    expect(result.matchedPatterns).toEqual(["internal-id"]);
  });

  it("throws an explicit error for an invalid regex", () => {
    expect(() => compilePatterns(["([unclosed"])).toThrow();
  });
});

describe("truncation by maxTextLength", () => {
  it("does not truncate text exactly at the limit", () => {
    const text = "a".repeat(DEFAULT_CONFIG.maxTextLength);
    const result = sanitize(text);
    expect(result.text).toBe(text);
    expect(result.text.length).toBe(4000);
    expect(result.truncated).toBe(false);
  });

  it("truncates text one character over the limit", () => {
    const text = "a".repeat(DEFAULT_CONFIG.maxTextLength) + "b";
    const result = sanitize(text);
    expect(result.text.length).toBe(4000);
    expect(result.text).toBe("a".repeat(4000));
    expect(result.truncated).toBe(true);
  });

  it("truncate(): boundary cases with a small limit", () => {
    expect(truncate("0123456789", 10)).toBe("0123456789");
    expect(truncate("0123456789A", 10)).toBe("0123456789");
    expect(truncate("", 10)).toBe("");
  });

  it("applies the limit after <private> stripping (stripped text under the limit is kept whole)", () => {
    const visible = "v".repeat(10);
    const text = `${visible}<private>${"p".repeat(50)}</private>`;
    const result = sanitizeText(text, { patterns: defaults(), maxTextLength: 10 });
    expect(result.text.trim()).toBe(visible);
    expect(result.truncated).toBe(false);
  });

  it("redacts before truncating: a secret straddling the limit does not leak partially", () => {
    // Truncating first would keep "...x AKIAI" (the key prefix) which no longer matches the pattern.
    const text = `${"x".repeat(94)} AKIAIOSFODNN7EXAMPLE tail`;
    const result = sanitizeText(text, { patterns: defaults(), maxTextLength: 100 });
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text).not.toContain("AKIA");
    expect(result.redacted).toBe(true);
    expect(result.truncated).toBe(true);
  });
});
