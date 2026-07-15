interface ChildEnvironmentInput {
  temporaryHome: string;
  temporaryDirectory: string;
  parentEnvironment?: NodeJS.ProcessEnv;
  metadata?: Record<string, string>;
}

const inheritedNames = ["PATH", "LANG", "LC_ALL", "TERM"] as const;

export function buildChildEnvironment(input: ChildEnvironmentInput): NodeJS.ProcessEnv {
  const parent = input.parentEnvironment ?? process.env;
  const environment: NodeJS.ProcessEnv = {};

  for (const name of inheritedNames) {
    const value = parent[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  environment.HOME = input.temporaryHome;
  environment.TMPDIR = input.temporaryDirectory;
  environment.CI = "1";

  for (const [name, value] of Object.entries(input.metadata ?? {})) {
    if (!/^GENKI_[A-Z0-9_]+$/u.test(name)) {
      throw new TypeError("Child metadata names must use the GENKI_ namespace");
    }
    environment[name] = value;
  }

  return environment;
}
