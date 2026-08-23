let ready = false;
let recoveryError = null;
const startedAt = new Date().toISOString();

export function markRuntimeReady() {
  ready = true;
  recoveryError = null;
}

export function markRuntimeNotReady(error = null) {
  ready = false;
  recoveryError = error?.message || null;
}

export function getRuntimeReadiness() {
  return {
    ready,
    recoveryError,
    startedAt,
  };
}
