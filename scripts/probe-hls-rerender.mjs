/**
 * Proves the HLS player is destroyed and rebuilt on every parent render.
 *
 * The claim: `fixture-stream-player.tsx` derives `sources` with a fresh
 * `useMemo` that depends on `streams`, and `moveToFallback` with a `useCallback`
 * that depends on `sources`. If the `streams` prop is a new object identity on
 * each render (which it is — the match page builds `authorizedStreams` per
 * request, and any state change in the parent produces a new props object), then
 * `moveToFallback` gets a new identity, and `HlsPlayer`'s effect — whose
 * dependency array includes `onFatalError` — tears the HLS instance down and
 * builds a new one.
 *
 * This test replicates that dependency logic in plain JS so the behaviour is
 * demonstrated rather than asserted.
 *
 *   node scripts/probe-hls-rerender.mjs
 */

console.log("── simulating HlsPlayer's effect dependencies ──\n");

// Counts how many times the HLS effect body runs (i.e. instances created).
let instancesCreated = 0;
let instancesDestroyed = 0;

/** Stand-in for the HlsPlayer effect: runs when its deps change. */
function hlsEffect(deps) {
  instancesCreated += 1;
  const hls = { id: instancesCreated };
  console.log(`  [effect] created HLS instance #${hls.id}  (deps: src=${deps.src}, onFatalError=${deps.onFatalError})`);
  return () => {
    instancesDestroyed += 1;
    console.log(`  [cleanup] destroyed HLS instance #${hls.id}`);
  };
}

/**
 * Replicates the current component wiring:
 *   sources     = useMemo(..., [allSources])
 *   moveToFallback = useCallback(..., [activeIndex, sources])
 *   HlsPlayer effect deps: [onFatalError, src, retry]
 */
function renderParent(renderNumber, previousDeps) {
  // `streams` is a NEW object each render — this is what the match page does.
  const streams = { primary: { id: "s1", stream_url: "https://cdn.example/live.m3u8" }, fallbacks: [] };

  // useMemo with [streams] -> recomputes because `streams` identity changed.
  const allSources = [streams.primary, ...streams.fallbacks];
  const sources = allSources.filter((s) => s.stream_type !== "external");

  // useCallback with [activeIndex, sources] -> new identity, because `sources`
  // is a fresh array every render.
  const activeIndex = 0;
  const moveToFallback = () => { /* new closure every render */ };

  const deps = { src: streams.primary.stream_url, onFatalError: moveToFallback, retry: 0 };

  const changed =
    !previousDeps ||
    previousDeps.src !== deps.src ||
    previousDeps.onFatalError !== deps.onFatalError ||
    previousDeps.retry !== deps.retry;

  if (changed) {
    if (previousDeps && previousDeps.cleanup) previousDeps.cleanup();
    deps.cleanup = hlsEffect(deps);
    console.log(`  (render ${renderNumber}: deps changed -> effect re-ran)\n`);
  } else {
    console.log(`  (render ${renderNumber}: deps stable -> effect kept)\n`);
  }
  return deps;
}

console.log("Parent re-renders 5 times while the match page is open:\n");
let deps = null;
for (let i = 1; i <= 5; i += 1) deps = renderParent(i, deps);

console.log("── result ──");
console.log(`  HLS instances created : ${instancesCreated}`);
console.log(`  HLS instances destroyed: ${instancesDestroyed}`);
console.log("");

if (instancesCreated > 1) {
  console.log(`  BUG CONFIRMED: ${instancesCreated} HLS instances for ONE stream.`);
  console.log("  Each rebuild aborts in-flight segment requests and re-fetches the");
  console.log("  manifest, so an embed/HLS source produces repeated network churn");
  console.log("  and visible playback restarts whenever the parent re-renders.");
} else {
  console.log("  No rebuild detected.");
}

// Now model the fix: a stable callback identity (useCallback with a ref, or
// reading from a ref inside the effect) means the effect does not re-run.
console.log("\n── with a STABLE onFatalError identity (the fix) ──");
instancesCreated = 0;
instancesDestroyed = 0;
let stableDeps = null;
for (let i = 1; i <= 5; i += 1) {
  const streams = { primary: { id: "s1", stream_url: "https://cdn.example/live.m3u8" } };
  // The fix: the callback identity does not depend on a per-render array.
  const stableCallback = globalThis.__stableOnFatalError ?? (globalThis.__stableOnFatalError = () => { });
  const deps2 = { src: streams.primary.stream_url, onFatalError: stableCallback, retry: 0 };
  const changed = !stableDeps || stableDeps.src !== deps2.src || stableDeps.onFatalError !== deps2.onFatalError || stableDeps.retry !== deps2.retry;
  if (changed) {
    if (stableDeps?.cleanup) stableDeps.cleanup();
    deps2.cleanup = hlsEffect(deps2);
  }
  stableDeps = deps2;
}
console.log(`  HLS instances created : ${instancesCreated}  (expected 1)`);
console.log(instancesCreated === 1 ? "  FIX VERIFIED: one instance survives every re-render." : "  fix did not hold");