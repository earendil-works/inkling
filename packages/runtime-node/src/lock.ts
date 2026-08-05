import path from "node:path";

import { FileSystem } from "@effect/platform";
import { Data, Effect, Predicate, type Scope } from "effect";

export class DataDirectoryLockError extends Data.TaggedError("DataDirectoryLockError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function acquireDataDirectoryLock(
  dataDirectory: string,
): Effect.Effect<void, DataDirectoryLockError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(dataDirectory, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DataDirectoryLockError({
              cause,
              message: "Jot cannot create its data directory.",
            }),
        ),
      );
      const lockPath = path.join(dataDirectory, ".jot.lock");
      yield* removeStaleLock(fileSystem, lockPath);
      yield* Effect.scoped(
        fileSystem.open(lockPath, { flag: "wx", mode: 0o600 }).pipe(
          Effect.mapError(
            (cause) =>
              new DataDirectoryLockError({
                cause,
                message: "Another Jot process owns this data directory.",
              }),
          ),
          Effect.flatMap((file) =>
            file
              .writeAll(
                new TextEncoder().encode(
                  JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid }),
                ),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new DataDirectoryLockError({
                      cause,
                      message: "Jot cannot write its data-directory lock.",
                    }),
                ),
              ),
          ),
        ),
      );
      return lockPath;
    }),
    (lockPath) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore);
      }),
  ).pipe(Effect.asVoid);
}

function removeStaleLock(
  fileSystem: FileSystem.FileSystem,
  lockPath: string,
): Effect.Effect<void, DataDirectoryLockError> {
  return fileSystem.exists(lockPath).pipe(
    Effect.mapError(
      (cause) =>
        new DataDirectoryLockError({ cause, message: "Jot cannot inspect its data lock." }),
    ),
    Effect.flatMap((exists) => {
      if (!exists) {
        return Effect.void;
      }
      return fileSystem.readFileString(lockPath).pipe(
        Effect.map(parseLock),
        Effect.catchAll(() => Effect.succeed(undefined)),
        Effect.flatMap((record) => {
          const pid = record?.pid;
          if (typeof pid === "number" && Number.isSafeInteger(pid) && isProcessAlive(pid)) {
            return Effect.fail(
              new DataDirectoryLockError({
                message: `Another Jot process (PID ${pid}) owns this data directory.`,
              }),
            );
          }
          return fileSystem.remove(lockPath, { force: true }).pipe(
            Effect.mapError(
              (cause) =>
                new DataDirectoryLockError({
                  cause,
                  message: "Jot cannot remove a stale data lock.",
                }),
            ),
          );
        }),
      );
    }),
  );
}

function parseLock(contents: string): { readonly pid?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    return Predicate.isReadonlyRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Predicate.isReadonlyRecord(error) && error["code"] === "EPERM";
  }
}
