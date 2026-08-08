import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { Data, Effect, Schema } from "effect";

const instanceSchema = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  baseUrl: Schema.String,
  capabilityToken: Schema.optional(Schema.String),
  documentId: Schema.optional(Schema.String),
  name: Schema.String,
});

const configSchema = Schema.Struct({
  active: Schema.optional(Schema.String),
  instances: Schema.Array(instanceSchema),
  version: Schema.Literal(1),
});

export type Instance = typeof instanceSchema.Type;
export type Config = typeof configSchema.Type;

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function loadConfig(): Effect.Effect<Config, ConfigError> {
  const filePath = configPath();
  return Effect.tryPromise({
    catch: (cause) => cause,
    try: () => fs.readFile(filePath, "utf8"),
  }).pipe(
    Effect.flatMap((contents) =>
      Schema.decodeUnknown(Schema.parseJson(configSchema))(contents).pipe(
        Effect.mapError(
          (cause) => new ConfigError({ cause, message: `Invalid Inkling config at ${filePath}.` }),
        ),
      ),
    ),
    Effect.catchAll((cause) =>
      isNodeError(cause) && cause.code === "ENOENT"
        ? Effect.succeed({ instances: [], version: 1 as const })
        : Effect.fail(
            cause instanceof ConfigError
              ? cause
              : new ConfigError({ cause, message: `Cannot read Inkling config at ${filePath}.` }),
          ),
    ),
  );
}

export function saveConfig(config: Config): Effect.Effect<void, ConfigError> {
  const filePath = configPath();
  const directory = path.dirname(filePath);
  return Effect.tryPromise({
    catch: (cause) =>
      new ConfigError({ cause, message: `Cannot write Inkling config at ${filePath}.` }),
    try: async () => {
      await fs.mkdir(directory, { mode: 0o700, recursive: true });
      const temporary = `${filePath}.tmp-${process.pid}`;
      await fs.writeFile(temporary, `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, filePath);
      await fs.chmod(filePath, 0o600);
    },
  });
}

export function selectedInstance(config: Config): Effect.Effect<Instance, ConfigError> {
  const name = process.env["INKLING_INSTANCE"] ?? config.active;
  const instance =
    name === undefined && config.instances.length === 1
      ? config.instances[0]
      : config.instances.find((item) => item.name === name);
  return instance === undefined
    ? Effect.fail(
        new ConfigError({
          message: "No Inkling instance is selected. Run `inkling instance add` and `inkling use`.",
        }),
      )
    : Effect.succeed(instance);
}

export function upsertInstance(config: Config, instance: Instance): Config {
  return {
    ...config,
    active: config.active ?? instance.name,
    instances: [
      ...config.instances.filter((existing) => existing.name !== instance.name),
      instance,
    ].toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

function configPath(): string {
  return (
    process.env["INKLING_CONFIG"] ??
    path.join(
      process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"),
      "inkling",
      "config.json",
    )
  );
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
