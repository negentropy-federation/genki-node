import { describe, expect, it } from "vitest";

import { buildChildEnvironment } from "./environment.js";

describe("buildChildEnvironment", () => {
  it("copies only allowlisted parent values and explicit Genki metadata", () => {
    const environment = buildChildEnvironment({
      temporaryHome: "/tmp/genki-home",
      temporaryDirectory: "/tmp/genki-tmp",
      parentEnvironment: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "secret-openai",
        AWS_SECRET_ACCESS_KEY: "secret-aws",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        UNRELATED: "do-not-copy"
      },
      metadata: { GENKI_SESSION_ID: "session-1", GENKI_RUN_ID: "run-1" }
    });

    expect(environment).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      HOME: "/tmp/genki-home",
      TMPDIR: "/tmp/genki-tmp",
      CI: "1",
      GENKI_SESSION_ID: "session-1",
      GENKI_RUN_ID: "run-1"
    });
    expect(JSON.stringify(environment)).not.toContain("secret");
  });

  it("rejects metadata outside the GENKI namespace", () => {
    expect(() =>
      buildChildEnvironment({
        temporaryHome: "/tmp/home",
        temporaryDirectory: "/tmp/tmp",
        parentEnvironment: {},
        metadata: { PATH: "/malicious" }
      })
    ).toThrow("GENKI_");
  });
});
