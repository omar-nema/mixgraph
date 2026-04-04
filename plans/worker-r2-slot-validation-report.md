# Worker R2 Slot Validation Report

> Status: Open
> Date: 2026-03-31
> Scope: `worker/index.js`

---

## Summary

The Cloudflare Worker can return clusters with fewer rank-2 nodes than are actually available.

In `selectClusterFromKV()`, rank-2 candidate IDs are added to `usedIds` before the KV fetch completes and before the fetched node is validated as playable. If a fetched node is missing or unplayable, that slot is dropped, but the Worker does not continue scanning for another valid rank-2 neighbor.

This means some clusters look artificially thin even when the graph contains enough valid rank-2 nodes to fill the requested layout.

---

## Severity

**Severity: Medium** | **Priority: P2** | **Status: Open**

This is not a crash or data-corruption issue, but it directly affects cluster quality and makes the Worker behave less reliably under normal usage.

---

## Affected Code

File: `worker/index.js`

Relevant block:

- Builds `r2Candidates`
- Slices the first `r2Limit`
- Immediately adds those IDs to `usedIds`
- Fetches them later in parallel
- Silently skips any null or unplayable result

Current behavior lives in the rank-2 selection flow inside `selectClusterFromKV()`.

---

## Root Cause

The reservation step happens too early.

Current flow:

1. Build rank-2 candidate list from an R1 node.
2. Shuffle candidates.
3. Take the first `r2Limit` entries.
4. Add each selected candidate ID to `usedIds`.
5. Fetch those nodes from KV.
6. Drop any node that is missing or unplayable.

The problem is that step 4 happens before steps 5 and 6 confirm the node is usable.

Because of that:

- invalid candidates still consume scarce selection slots
- later valid neighbors are never considered
- cluster density depends on fetch/validation outcome, not just graph structure

---

## User Impact

Users can see:

- fewer rank-2 cards than expected
- weaker-looking clusters for otherwise well-connected roots
- inconsistent cluster depth between local/server logic and Worker logic

This is especially noticeable because the UI already treats sparse clusters as lower-quality results.

---

## Why This Matters

The app’s core experience depends on clusters feeling rich and connected. A selection bug in the Worker reduces quality right at the API layer, which then propagates into:

- shallower graph renders
- less interesting “show more” expansions
- more rerolls needed to find a satisfying cluster

Even when the underlying data is good, the selection algorithm can make it look worse than it is.

---

## Recommended Fix

Update the Worker so rank-2 IDs are only added to `usedIds` after validation succeeds, or continue selecting until `r2Limit` playable children are found.

Two reasonable approaches:

### Option 1: Validate before reserving

- fetch candidate rank-2 nodes first
- keep only nodes that exist and are playable
- add accepted IDs to `usedIds`
- stop once `r2Limit` valid nodes are collected

### Option 2: Over-select then backfill

- keep the current batched fetch shape
- fetch more than `r2Limit` candidates
- accept valid results in order
- continue until enough playable nodes are found

Option 1 is simpler to reason about. Option 2 may preserve more of the current parallelism.

---

## Suggested Acceptance Criteria

- A missing or unplayable R2 candidate does not permanently consume a rank-2 slot.
- The Worker keeps searching until it finds up to `r2Limit` valid R2 nodes or exhausts the candidate pool.
- `usedIds` only contains nodes that were actually admitted into the returned cluster.
- Returned cluster depth is more consistent for roots with adequate valid neighbors.

---

## Test Ideas

- Create a root/R1 fixture where the first shuffled R2 candidate is unplayable and a later candidate is playable.
- Verify the Worker still returns the playable R2 node instead of leaving the slot empty.
- Add a case where KV returns `null` for one candidate and ensure the Worker backfills from later neighbors.
- Compare Worker output against the expected number of valid rank-2 nodes for a controlled graph fixture.

---

## Follow-Up

This is also a good signal to reduce logic drift between:

- `worker/index.js`
- `shared/graph-logic.js`
- `server/local-server.js`

The more cluster-selection behavior is duplicated across adapters, the easier it is for bugs like this to exist in only one runtime.
