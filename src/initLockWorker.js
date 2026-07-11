import properLockfile from "proper-lockfile";
import { workerData } from "node:worker_threads";

const ACQUIRE_STATE = 0;
const RELEASE_STATE = 1;
const COMPROMISED_STATE = 2;
const SUCCEEDED = 1;
const FAILED = 2;

const state = new Int32Array(workerData.stateBuffer);
const controlPort = workerData.controlPort;
let releaseLock;
let releaseRequested = false;
let releaseStarted = false;
let compromisedError;

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code,
    stack: error?.stack
  };
}

function report(index, phase, status, error) {
  controlPort.postMessage({
    phase,
    error: error ? serializeError(error) : null
  });
  Atomics.store(state, index, status);
  Atomics.notify(state, index);
}

async function release() {
  if (releaseStarted) return;
  releaseStarted = true;

  let releaseError;
  try {
    await releaseLock?.();
  } catch (error) {
    releaseError = error;
  }

  const error = compromisedError || releaseError;
  report(RELEASE_STATE, "release", error ? FAILED : SUCCEEDED, error);
  controlPort.close();
}

controlPort.on("message", (message) => {
  if (message?.type !== "release") return;
  releaseRequested = true;
  if (releaseLock) void release();
});
controlPort.start();

process.on("exit", () => {
  if (Atomics.load(state, ACQUIRE_STATE) === 0) {
    Atomics.store(state, ACQUIRE_STATE, FAILED);
    Atomics.notify(state, ACQUIRE_STATE);
  } else if (Atomics.load(state, RELEASE_STATE) === 0) {
    Atomics.store(state, RELEASE_STATE, FAILED);
    Atomics.notify(state, RELEASE_STATE);
  }
});

try {
  releaseLock = await properLockfile.lock(workerData.dbPath, {
    ...workerData.lockOptions,
    onCompromised(error) {
      compromisedError ??= error;
      Atomics.store(state, COMPROMISED_STATE, FAILED);
      Atomics.notify(state, COMPROMISED_STATE);
    }
  });
  report(ACQUIRE_STATE, "acquire", SUCCEEDED);
  if (releaseRequested) await release();
} catch (error) {
  report(ACQUIRE_STATE, "acquire", FAILED, error);
  controlPort.close();
}
